import {
  createPublicClient,
  decodeEventLog,
  fallback,
  http,
  parseAbi,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { bsc } from "viem/chains";

import { config } from "./config.js";
import { bytes32ToWrapId, wrapIdToBytes32 } from "./claim.js";

const wBLOZAbi = parseAbi(["function totalSupply() view returns (uint256)"]);

const bridgeAbi = parseAbi([
  "event UnwrapRequested(uint256 indexed unwrapId, address indexed user, uint256 amount, string bz1Address)",
]);

const claimAbi = parseAbi([
  "event WrapClaimed(bytes32 indexed wrapId, address indexed to, uint256 amount)",
  "function claimed(bytes32 wrapId) view returns (bool)",
]);

const chain = config.bsc.chainId === 56 ? bsc : { ...bsc, id: config.bsc.chainId };

const defaultRpcs = [
  "https://bsc-dataseed.binance.org/",
  "https://bsc-dataseed1.binance.org/",
  "https://bsc-dataseed2.binance.org/",
  "https://bsc-dataseed3.binance.org/",
];

export const publicClient = createPublicClient({
  chain,
  transport: fallback(
    (config.bsc.rpcUrls.length ? config.bsc.rpcUrls : defaultRpcs).map((url) => http(url))
  ),
});

function isLogRangeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("limit exceeded") ||
    msg.includes("query returned more than") ||
    msg.includes("rate limit")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getLogsChunked<T extends Log>(
  fetchChunk: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint
): Promise<T[]> {
  if (fromBlock > toBlock) return [];

  const span = toBlock - fromBlock + 1n;
  // Public BSC RPCs rate-limit wide getLogs ranges — scan block-by-block when near tip.
  if (span <= 2000n) {
    const out: T[] = [];
    for (let b = fromBlock; b <= toBlock; b++) {
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          out.push(...(await fetchChunk(b, b)));
          ok = true;
        } catch (err) {
          if (!isLogRangeError(err) || attempt === 2) throw err;
          await sleep(400 * (attempt + 1));
        }
      }
      if (b < toBlock) await sleep(120);
    }
    return out;
  }

  let chunk = config.bsc.logChunkBlocks;
  const out: T[] = [];
  let cursor = fromBlock;

  while (cursor <= toBlock) {
    let end = cursor + chunk - 1n;
    if (end > toBlock) end = toBlock;

    try {
      out.push(...(await fetchChunk(cursor, end)));
      cursor = end + 1n;
      chunk = config.bsc.logChunkBlocks;
      continue;
    } catch (err) {
      if (!isLogRangeError(err) || chunk <= 1n) throw err;
      chunk = chunk / 2n;
      if (chunk < 1n) chunk = 1n;
      console.warn(`BSC getLogs chunk ${cursor}-${end} too large, retry with chunk=${chunk}`);
    }
  }

  return out;
}

export async function getWBLOZTotalSupply(): Promise<bigint> {
  return publicClient.readContract({
    address: config.bsc.wBLOZAddress,
    abi: wBLOZAbi,
    functionName: "totalSupply",
  });
}

export type ClaimEvent = {
  wrapId: string;
  to: `0x${string}`;
  amount: bigint;
  txHash: Hex;
  blockNumber: bigint;
};

/** Returns events plus scanEnd — the last block actually scanned; cursors must advance to scanEnd, not tip. */
export async function fetchClaimEvents(
  fromBlock: bigint
): Promise<{ events: ClaimEvent[]; scanEnd: bigint }> {
  const latest = await getLatestBlock();
  // Stay a little behind tip: the fallback RPCs can lag each other by a block or two.
  const scanEnd = latest > 2n ? latest - 2n : 0n;
  if (!config.bsc.wrapClaimAddress || fromBlock > scanEnd) return { events: [], scanEnd };

  const span = scanEnd - fromBlock + 1n;

  if (span > 5000n) {
    const logs = await getLogsChunked(
      (from, to) =>
        publicClient.getLogs({
          address: config.bsc.wrapClaimAddress,
          event: claimAbi[0],
          fromBlock: from,
          toBlock: to,
        }),
      fromBlock,
      scanEnd
    );

    const events = logs.map((log) => {
      const decoded = decodeEventLog({
        abi: claimAbi,
        data: log.data,
        topics: log.topics,
      });
      const wrapIdBytes = decoded.args.wrapId as Hex;
      return {
        wrapId: bytes32ToWrapId(wrapIdBytes),
        to: decoded.args.to as `0x${string}`,
        amount: decoded.args.amount as bigint,
        txHash: log.transactionHash!,
        blockNumber: log.blockNumber ?? 0n,
      };
    });
    return { events, scanEnd };
  }

  const claimAddr = config.bsc.wrapClaimAddress.toLowerCase();
  const out: ClaimEvent[] = [];

  for (let b = fromBlock; b <= scanEnd; b++) {
    const block = await publicClient.getBlock({ blockNumber: b, includeTransactions: true });
    const claimTxHashes: Hex[] = [];

    for (const tx of block.transactions) {
      if (typeof tx === "string") continue;
      if (tx.to?.toLowerCase() !== claimAddr) continue;
      claimTxHashes.push(tx.hash);
    }

    for (const hash of claimTxHashes) {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== claimAddr) continue;
        try {
          const decoded = decodeEventLog({
            abi: claimAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName !== "WrapClaimed") continue;
          const wrapIdBytes = decoded.args.wrapId as Hex;
          out.push({
            wrapId: bytes32ToWrapId(wrapIdBytes),
            to: decoded.args.to as `0x${string}`,
            amount: decoded.args.amount as bigint,
            txHash: hash,
            blockNumber: b,
          });
        } catch {
          /* ignore */
        }
      }
    }

    if (b < scanEnd) await sleep(40);
  }

  return { events: out, scanEnd };
}

const UNWRAP_SELECTOR = "0x307cf63f";

type UnwrapEvent = {
  unwrapId: bigint;
  user: `0x${string}`;
  amount: bigint;
  bz1Address: string;
  blockNumber: bigint;
};

function unwrapEventsFromReceipt(receipt: TransactionReceipt, blockNumber: bigint): UnwrapEvent[] {
  const bridge = config.bsc.bridgeAddress.toLowerCase();
  const out: UnwrapEvent[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== bridge) continue;
    try {
      const decoded = decodeEventLog({
        abi: bridgeAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "UnwrapRequested") continue;
      out.push({
        unwrapId: decoded.args.unwrapId as bigint,
        user: decoded.args.user as `0x${string}`,
        amount: decoded.args.amount as bigint,
        bz1Address: decoded.args.bz1Address as string,
        blockNumber,
      });
    } catch {
      /* not an unwrap log */
    }
  }
  return out;
}

/** Scan blocks for unwrap() txs — avoids eth_getLogs (rate-limited on public BSC RPCs). */
async function fetchUnwrapEventsViaBlocks(fromBlock: bigint, toBlock: bigint): Promise<UnwrapEvent[]> {
  if (fromBlock > toBlock) return [];

  const bridge = config.bsc.bridgeAddress.toLowerCase();
  const out: UnwrapEvent[] = [];

  for (let b = fromBlock; b <= toBlock; b++) {
    const block = await publicClient.getBlock({ blockNumber: b, includeTransactions: true });
    const unwrapTxHashes: Hex[] = [];

    for (const tx of block.transactions) {
      if (typeof tx === "string") continue;
      if (tx.to?.toLowerCase() !== bridge) continue;
      if (!tx.input.startsWith(UNWRAP_SELECTOR)) continue;
      unwrapTxHashes.push(tx.hash);
    }

    for (const hash of unwrapTxHashes) {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      out.push(...unwrapEventsFromReceipt(receipt, b));
    }

    if (b < toBlock) await sleep(40);
  }

  return out;
}

/** Returns events plus scanEnd — the last block actually scanned; cursors must advance to scanEnd, not tip. */
export async function fetchUnwrapEvents(
  fromBlock: bigint
): Promise<{ events: UnwrapEvent[]; scanEnd: bigint }> {
  const latest = await getLatestBlock();
  // Stay a little behind tip: the fallback RPCs can lag each other by a block or two.
  const scanEnd = latest > 2n ? latest - 2n : 0n;
  if (fromBlock > scanEnd) return { events: [], scanEnd };

  const span = scanEnd - fromBlock + 1n;

  // Wide historical scans still use getLogs (backfill scripts); live polling uses block scan.
  if (span > 5000n) {
    const logs = await getLogsChunked(
      (from, to) =>
        publicClient.getLogs({
          address: config.bsc.bridgeAddress,
          event: bridgeAbi[0],
          fromBlock: from,
          toBlock: to,
        }),
      fromBlock,
      scanEnd
    );

    const events = logs.map((log) => {
      const decoded = decodeEventLog({
        abi: bridgeAbi,
        data: log.data,
        topics: log.topics,
      });
      return {
        unwrapId: decoded.args.unwrapId as bigint,
        user: decoded.args.user as `0x${string}`,
        amount: decoded.args.amount as bigint,
        bz1Address: decoded.args.bz1Address as string,
        blockNumber: log.blockNumber ?? 0n,
      };
    });
    return { events, scanEnd };
  }

  return { events: await fetchUnwrapEventsViaBlocks(fromBlock, scanEnd), scanEnd };
}

export async function getLatestBlock(): Promise<bigint> {
  return publicClient.getBlockNumber();
}

export async function isWrapClaimedOnChain(wrapId: string): Promise<boolean> {
  if (!config.bsc.wrapClaimAddress) return false;
  try {
    return await publicClient.readContract({
      address: config.bsc.wrapClaimAddress,
      abi: claimAbi,
      functionName: "claimed",
      args: [wrapIdToBytes32(wrapId)],
    });
  } catch {
    return false;
  }
}
