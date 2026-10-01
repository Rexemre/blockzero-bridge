import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export const config = {
  port: num("BRIDGE_PORT", 3010),
  dbPath: process.env.BRIDGE_DB_PATH ?? "./data/bridge.db",
  webDir: process.env.BRIDGE_WEB_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web"),

  bloz: {
    cli: process.env.BLOZ_CLI ?? "/opt/blockzero/bin/bitcoin-cli",
    datadir: req("BLOZ_DATADIR"),
    wallet: process.env.BLOZ_BRIDGE_WALLET ?? "bridge",
    confirmations: num("BLOZ_CONFIRMATIONS", 6),
    wrapExpiryHours: num("WRAP_EXPIRY_HOURS", 48),
    minWrapBloz: process.env.MIN_WRAP_BLOZ ?? "0.01",
    /** Deducted from native BLOZ payout on unwrap (covers chain tx fee). */
    unwrapNetworkFeeBloz: process.env.UNWRAP_NETWORK_FEE_BLOZ ?? "0.00001",
    /** Bridge service fee in basis points, applied on wrap (mint) and unwrap (payout). 0 = no fee. */
    bridgeFeeBps: num("BRIDGE_FEE_BPS", 0),
    /** Dedicated bz1 address that receives the bridge fee on wrap (after mint) and unwrap (unused when fee is 0). */
    feeBz1Address: (() => {
      const v = process.env.BRIDGE_FEE_BZ1_ADDRESS?.trim();
      if (!v) return null;
      if (!v.startsWith("bz1")) {
        throw new Error("BRIDGE_FEE_BZ1_ADDRESS must be a mainnet bz1 address");
      }
      return v;
    })(),
    unwrapMaxAttempts: num("UNWRAP_MAX_ATTEMPTS", 5),
    unwrapRetryDelayMs: num("UNWRAP_RETRY_DELAY_MS", 60_000),
    /** Hours after a deposit is claimable before unclaimed BLOZ is auto-refunded. */
    claimExpiryHours: num("CLAIM_EXPIRY_HOURS", 168),
    refundMaxAttempts: num("REFUND_MAX_ATTEMPTS", 5),
    refundRetryDelayMs: num("REFUND_RETRY_DELAY_MS", 60_000),
    /** EIP-712 claim signature TTL — must be <= refund delay after claim_expires_at */
    claimSigTtlSec: num("CLAIM_SIG_TTL_SEC", 3600),
  },

  meta: {
    githubUrl:
      process.env.BRIDGE_GITHUB_URL ?? "https://github.com/Rexemre/blockzero-bridge",
    docsUrl:
      process.env.BRIDGE_DOCS_URL ??
      "https://github.com/Rexemre/blockzero-docs/blob/main/bridge-guide.md",
    operatorAddress: process.env.BSC_OPERATOR_ADDRESS,
    deployerAddress: process.env.BSC_DEPLOYER_ADDRESS,
  },

  bsc: {
    rpcUrls: (process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org/")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    /** BSC block when BlozBridge was deployed (used for log backfill if cursor missing). */
    bridgeDeployBlock: process.env.BSC_BRIDGE_DEPLOY_BLOCK
      ? BigInt(process.env.BSC_BRIDGE_DEPLOY_BLOCK)
      : undefined,
    /** BSC block when BlozWrapClaim was deployed. */
    wrapClaimDeployBlock: process.env.BSC_WRAP_CLAIM_DEPLOY_BLOCK
      ? BigInt(process.env.BSC_WRAP_CLAIM_DEPLOY_BLOCK)
      : undefined,
    /** Fallback deploy block (~2026-06-08) when specific env vars are unset. */
    defaultDeployBlock: BigInt(process.env.BSC_DEFAULT_DEPLOY_BLOCK ?? "106550000"),
    /** Max block span per eth_getLogs call (public BSC RPCs reject large ranges). */
    logChunkBlocks: BigInt(num("BSC_LOG_CHUNK_BLOCKS", 500)),
    chainId: num("BSC_CHAIN_ID", 56),
    operatorKey: req("BSC_OPERATOR_PRIVATE_KEY") as `0x${string}`,
    wBLOZAddress: req("WBLOZ_ADDRESS") as `0x${string}`,
    bridgeAddress: req("BRIDGE_ADDRESS") as `0x${string}`,
    wrapClaimAddress: process.env.WRAP_CLAIM_ADDRESS as `0x${string}` | undefined,
    /**
     * Extra endpoints tried after BSC_RPC_URL when a block/receipt is not served (BlockNotFound,
     * timeout, rate limit). Set to an empty string to disable.
     */
    rpcFallbackUrls: (
      process.env.BSC_RPC_FALLBACK_URLS ??
      [
        "https://bsc-rpc.publicnode.com",
        "https://bsc-dataseed.bnbchain.org",
        "https://bsc-dataseed3.binance.org/",
        "https://bsc-dataseed4.binance.org/",
        "https://bsc-dataseed1.defibit.io/",
        "https://bsc-dataseed1.ninicoin.io/",
      ].join(",")
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    /** Per-request timeout for the live scan endpoints. */
    rpcTimeoutMs: num("BSC_RPC_TIMEOUT_MS", 8_000),
    /** Live pollers stop this many blocks behind the tip (load-balanced RPCs lag a few blocks). */
    scanLagBlocks: BigInt(num("BSC_SCAN_LAG_BLOCKS", 5)),
    /** Backoff cap while no endpoint serves the next block. */
    stallBackoffMaxMs: num("BSC_STALL_BACKOFF_MAX_MS", 120_000),
    /** A continuous stall longer than this is logged as an error (once per period). */
    stallEscalateMs: num("BSC_STALL_ESCALATE_MS", 600_000),
    pollMs: num("BSC_POLL_MS", 12_000),
    blozPollMs: num("BLOZ_POLL_MS", 15_000),
  },
};
