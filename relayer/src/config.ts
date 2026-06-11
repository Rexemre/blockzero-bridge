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
    /** Bridge service fee in basis points, applied on wrap (mint) and unwrap (payout). 390 = 3.9%. */
    bridgeFeeBps: num("BRIDGE_FEE_BPS", 390),
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
    rpcUrl: process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org/",
    chainId: num("BSC_CHAIN_ID", 56),
    operatorKey: req("BSC_OPERATOR_PRIVATE_KEY") as `0x${string}`,
    wBLOZAddress: req("WBLOZ_ADDRESS") as `0x${string}`,
    bridgeAddress: req("BRIDGE_ADDRESS") as `0x${string}`,
    wrapClaimAddress: process.env.WRAP_CLAIM_ADDRESS as `0x${string}` | undefined,
    pollMs: num("BSC_POLL_MS", 12_000),
    blozPollMs: num("BLOZ_POLL_MS", 15_000),
  },
};
