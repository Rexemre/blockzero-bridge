import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { config } from "./config.js";

const account = privateKeyToAccount(config.bsc.operatorKey);

export function wrapIdToBytes32(id: string): Hex {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) throw new Error("invalid wrap id");
  return `0x${hex.padStart(64, "0")}` as Hex;
}

export function bytes32ToWrapId(bytes32: Hex): string {
  const hex = bytes32.slice(2).replace(/^0+/, "") || "0";
  const h = hex.padStart(32, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function signWrapClaim(params: {
  to: `0x${string}`;
  amountUnits: bigint;
  wrapId: string;
  deadline: number;
}): Promise<Hex> {
  if (!config.bsc.wrapClaimAddress) {
    throw new Error("WRAP_CLAIM_ADDRESS not configured");
  }

  return account.signTypedData({
    domain: {
      name: "BlozWrapClaim",
      version: "1",
      chainId: config.bsc.chainId,
      verifyingContract: config.bsc.wrapClaimAddress,
    },
    types: {
      Claim: [
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "wrapId", type: "bytes32" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Claim",
    message: {
      to: params.to,
      amount: params.amountUnits,
      wrapId: wrapIdToBytes32(params.wrapId),
      deadline: BigInt(params.deadline),
    },
  });
}
