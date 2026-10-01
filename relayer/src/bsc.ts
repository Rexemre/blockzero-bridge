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
import {
  RpcPool,
  RpcPoolExhausted,
  StallGate,
  mergeRpcUrls,
  rpcLabel,
  scanBlockRange,
  scanTarget,
  type BlockVisitor,
  type ScanRpc,
} from "./bsc-scan.js";

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

const rpcUrls = mergeRpcUrls(
  config.bsc.rpcUrls.length ? config.bsc.rpcUrls : defaultRpcs,
  config.bsc.rpcFallbackUrls
);

export const publicClient = createPublicClient({
  chain,
  transport: fallback(rpcUrls.map((url) => http(url))),
});

/**
 * Live event scans use one client per endpoint (no viem retries/fallback) so a "block not found"
 * from a lagging backend rotates to the next endpoint instead of failing the whole poll.
 */
const scanPool = new RpcPool(
  rpcUrls.map((url): ScanRpc => {
    const client = createPublicClient({
      chain,
      transport: http(url, { timeout: config.bsc.rpcTimeoutMs, retryCount: 0 }),
    });
    return {
      name: rpcLabel(url),
      blockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
      blockTxs: async (blockNumber) => {
        const block = await client.getBlock({ blockNumber, includeTransactions: true });
        return block.transactions.filter((tx) => typeof tx !== "string");
      },
      receipt: (hash) => client.getTransactionReceipt({ hash }),
    };
  })
);

function stallGate(stream: string): StallGate {
  return new StallGate(stream, {
    baseDelayMs: config.bsc.pollMs,
    maxDelayMs: config.bsc.stallBackoffMaxMs,
    escalateAfterMs: config.bsc.stallEscalateMs,
  });
}

const unwrapGate = stallGate("unwrap");
const claimGate = stallGate("claim");

/**
 * Block-scan [fromBlock, tip - lag] through the endpoint pool. Never throws for RPC trouble:
 * it returns the range actually scanned (possibly empty → scanEnd = fromBlock - 1, which leaves
 * the cursor untouched) and backs off with a throttled warning.
 */
async function liveBlockScan<E>(
  gate: StallGate,
  fromBlock: bigint,
  visit: BlockVisitor<E>,
  wide: (scanEnd: bigint) => Promise<E[]>
): Promise<{ events: E[]; scanEnd: bigint }> {
  const nothing = { events: [] as E[], scanEnd: fromBlock - 1n };
  if (!gate.ready()) return nothing;

  let target: bigint;
  try {
    target = await scanTarget(scanPool, config.bsc.scanLagBlocks);
  } catch (err) {
    if (!(err instanceof RpcPoolExhausted)) throw err;
    gate.onStall(undefined, err.reason, false);
    return nothing;
  }
  if (fromBlock > target) return { events: [], scanEnd: target };

  // Wide historical ranges (cursor far behind) keep the getLogs path.
  if (target - fromBlock + 1n > 5000n) return { events: await wide(target), scanEnd: target };

  const res = await scanBlockRange(scanPool, fromBlock, target, visit);
  if (res.stalledAt !== undefined) {
    gate.onStall(res.stalledAt, res.stallReason ?? "unknown", res.scanEnd >= fromBlock);
  } else {
    gate.onSuccess();
  }
  return { events: res.events, scanEnd: res.scanEnd };
}

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
  const claimAddress = config.bsc.wrapClaimAddress;
  if (!claimAddress) return { events: [], scanEnd: fromBlock - 1n };
  const claimAddr = claimAddress.toLowerCase();

  return liveBlockScan<ClaimEvent>(
    claimGate,
    fromBlock,
    async (pool, b, txs) => {
      const out: ClaimEvent[] = [];
      for (const tx of txs) {
        if (tx.to?.toLowerCase() !== claimAddr) continue;
        const receipt = await pool.call(`receipt ${tx.hash}`, (rpc) => rpc.receipt(tx.hash));
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
              txHash: tx.hash,
              blockNumber: b,
            });
          } catch {
            /* ignore */
          }
        }
      }
      return out;
    },
    async (scanEnd) => {
      const logs = await getLogsChunked(
        (from, to) =>
          publicClient.getLogs({
            address: claimAddress,
            event: claimAbi[0],
            fromBlock: from,
            toBlock: to,
          }),
        fromBlock,
        scanEnd
      );

      return logs.map((log) => {
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
    }
  );
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

/** Block-scan visitor for unwrap() txs — avoids eth_getLogs (rate-limited on public BSC RPCs). */
const visitUnwrapBlock: BlockVisitor<UnwrapEvent> = async (pool, b, txs) => {
  const bridge = config.bsc.bridgeAddress.toLowerCase();
  const out: UnwrapEvent[] = [];
  for (const tx of txs) {
    if (tx.to?.toLowerCase() !== bridge) continue;
    if (!tx.input.startsWith(UNWRAP_SELECTOR)) continue;
    const receipt = await pool.call(`receipt ${tx.hash}`, (rpc) => rpc.receipt(tx.hash));
    out.push(...unwrapEventsFromReceipt(receipt, b));
  }
  return out;
};

/** Returns events plus scanEnd — the last block actually scanned; cursors must advance to scanEnd, not tip. */
export async function fetchUnwrapEvents(
  fromBlock: bigint
): Promise<{ events: UnwrapEvent[]; scanEnd: bigint }> {
  // Wide historical scans still use getLogs (backfill scripts); live polling uses block scan.
  return liveBlockScan<UnwrapEvent>(unwrapGate, fromBlock, visitUnwrapBlock, async (scanEnd) => {
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

    return logs.map((log) => {
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
  });
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
