import {

  createPublicClient,

  decodeEventLog,

  http,

  parseAbi,

  type Hex,

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



export const publicClient = createPublicClient({

  chain,

  transport: http(config.bsc.rpcUrl),

});



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



  const logs = await publicClient.getLogs({

    address: config.bsc.wrapClaimAddress,

    event: claimAbi[0],

    fromBlock,

    toBlock: "latest",

  });



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

  const logs = await publicClient.getLogs({

    address: config.bsc.bridgeAddress,

    event: bridgeAbi[0],

    fromBlock,

    toBlock: "latest",

  });



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


