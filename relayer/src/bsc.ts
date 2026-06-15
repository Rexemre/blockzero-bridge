import {
  createPublicClient,
  decodeEventLog,
  fallback,
  http,
  parseAbi,
  type Hex,
  type Log,
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
  return msg.includes("limit exceeded") || msg.includes("query returned more than");
}

async function getLogsChunked<T extends Log>(
  fetchChunk: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  fromBlock: bigint
): Promise<T[]> {
  const latest = await getLatestBlock();
  if (fromBlock > latest) return [];

  let chunk = config.bsc.logChunkBlocks;
  const out: T[] = [];
  let cursor = fromBlock;

  while (cursor <= latest) {
    let end = cursor + chunk - 1n;
    if (end > latest) end = latest;

    try {
      out.push(...(await fetchChunk(cursor, end)));
      cursor = end + 1n;
      continue;
    } catch (err) {
      if (!isLogRangeError(err) || chunk <= 256n) throw err;
      chunk = chunk / 2n;
      if (chunk < 256n) chunk = 256n;
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

export async function fetchClaimEvents(fromBlock: bigint): Promise<
  Array<{
    wrapId: string;
    to: `0x${string}`;
    amount: bigint;
    txHash: Hex;
    blockNumber: bigint;
  }>
> {
  if (!config.bsc.wrapClaimAddress) return [];

  const logs = await getLogsChunked(
    (from, to) =>
      publicClient.getLogs({
        address: config.bsc.wrapClaimAddress,
        event: claimAbi[0],
        fromBlock: from,
        toBlock: to,
      }),
    fromBlock
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

export async function fetchUnwrapEvents(fromBlock: bigint): Promise<
  Array<{
    unwrapId: bigint;
    user: `0x${string}`;
    amount: bigint;
    bz1Address: string;
    blockNumber: bigint;
  }>
> {
  const logs = await getLogsChunked(
    (from, to) =>
      publicClient.getLogs({
        address: config.bsc.bridgeAddress,
        event: bridgeAbi[0],
        fromBlock: from,
        toBlock: to,
      }),
    fromBlock
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
