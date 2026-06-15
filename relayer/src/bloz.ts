import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const exec = promisify(execFile);

export interface BlozTx {
  txid: string;
  address: string;
  amount: number;
  confirmations: number;
  category: string;
}

function cliArgs(extra: string[]): string[] {
  return ["-datadir=" + config.bloz.datadir, "-rpcwallet=" + config.bloz.wallet, ...extra];
}

async function runCli(args: string[]): Promise<string> {
  const { stdout } = await exec(config.bloz.cli, cliArgs(args), {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function ensureBridgeWallet(): Promise<void> {
  try {
    await runCli(["getwalletinfo"]);
    return;
  } catch {
    /* wallet not loaded in this bitcoind session */
  }
  try {
    await runCli(["loadwallet", config.bloz.wallet]);
    return;
  } catch {
    /* wallet does not exist yet */
  }
  await runCli(["createwallet", config.bloz.wallet]);
}

export async function newDepositAddress(label: string): Promise<string> {
  return runCli(["getnewaddress", label, "bech32"]);
}

export async function listRecentReceives(count = 200): Promise<BlozTx[]> {
  return listRecentWalletTxs(count, (r) => r.category === "receive" && !!r.address && r.amount > 0);
}

type WalletTxRow = {
  txid: string;
  address?: string;
  amount: number;
  confirmations: number;
  category: string;
  time?: number;
  timereceived?: number;
};

async function listRecentWalletTxs(
  count: number,
  filter: (row: WalletTxRow) => boolean
): Promise<BlozTx[]> {
  const raw = await runCli(["listtransactions", "*", String(count), "0", "true"]);
  const rows = JSON.parse(raw) as WalletTxRow[];
  return rows
    .filter(filter)
    .map((r) => ({
      txid: r.txid,
      address: r.address!,
      amount: Math.abs(r.amount),
      confirmations: r.confirmations,
      category: r.category,
    }));
}

/** Recover payout tx after relayer crash (avoid double-send). */
export async function findRecentPayoutSend(
  toAddress: string,
  amountBloz: number,
  sinceMs: number
): Promise<string | null> {
  const raw = await runCli(["listtransactions", "*", "150", "0", "true"]);
  const rows = JSON.parse(raw) as WalletTxRow[];
  const sinceSec = Math.floor(sinceMs / 1000) - 120;
  const tolerance = 1e-7;

  for (const r of rows) {
    if (r.category !== "send" || r.address !== toAddress) continue;
    const sent = Math.abs(r.amount);
    if (Math.abs(sent - amountBloz) > tolerance) continue;
    const t = r.timereceived ?? r.time ?? 0;
    if (t > 0 && t < sinceSec) continue;
    return r.txid;
  }
  return null;
}

export async function sendBloz(toAddress: string, amountBloz: number): Promise<string> {
  // Bridge node often has no fee estimates yet — fee_rate=1 sat/vB (same as skim-fee-surplus.py).
  const txid = await runCli([
    "-named",
    "sendtoaddress",
    `address=${toAddress}`,
    `amount=${amountBloz.toFixed(8)}`,
    "fee_rate=1",
    "replaceable=true",
  ]);
  return txid;
}

export async function getBridgeBalance(): Promise<number> {
  const raw = await runCli(["getbalance"]);
  return Number(raw);
}

type RawTxVin = { txid?: string; vout?: number };
type RawTxVout = {
  scriptPubKey?: { address?: string; addresses?: string[] };
};
type RawTx = { vin?: RawTxVin[]; vout?: RawTxVout[] };

function pickBz1Address(script?: { address?: string; addresses?: string[] }): string | null {
  if (!script) return null;
  if (script.address?.startsWith("bz1")) return script.address;
  const fromList = script.addresses?.find((a) => a.startsWith("bz1"));
  return fromList ?? null;
}

async function rawTxFromRpc(txid: string): Promise<RawTx | null> {
  try {
    return JSON.parse(await runCli(["getrawtransaction", txid, "true"])) as RawTx;
  } catch {
    try {
      const wt = JSON.parse(await runCli(["gettransaction", txid, "true"])) as { hex?: string };
      if (!wt.hex) return null;
      return JSON.parse(await runCli(["decoderawtransaction", wt.hex])) as RawTx;
    } catch {
      return null;
    }
  }
}

/** Resolve the funding bz1 address for an incoming deposit tx (first input). */
export async function getDepositSenderBz1(txid: string): Promise<string | null> {
  try {
    const raw = await rawTxFromRpc(txid);
    if (!raw) return null;
    const vin = raw.vin?.[0];
    if (!vin?.txid || vin.vout === undefined) return null;
    const prev = await rawTxFromRpc(vin.txid);
    const out = prev?.vout?.[vin.vout];
    return pickBz1Address(out?.scriptPubKey) ?? null;
  } catch {
    return null;
  }
}

const RESERVE_FUNDING_LABELS = ["bridge-reserve-public", "bridge-reserve-funding"] as const;

/** Incoming BLOZ to these labels stays in the bridge wallet (no orphan auto-refund). */
export async function isBridgeReserveAddress(address: string): Promise<boolean> {
  for (const label of RESERVE_FUNDING_LABELS) {
    try {
      const raw = await runCli(["getaddressesbylabel", label]);
      const addrs = JSON.parse(raw) as Record<string, unknown>;
      if (address in addrs) return true;
    } catch {
      /* label may not exist yet */
    }
  }
  return false;
}

/** Stable public address label for reserve transparency (wallet may hold more than this address). */
export async function ensurePublicReserveAddress(): Promise<string> {
  try {
    const raw = await runCli(["getaddressesbylabel", "bridge-reserve-public"]);
    const addrs = JSON.parse(raw) as Record<string, unknown>;
    const first = Object.keys(addrs)[0];
    if (first) return first;
  } catch {
    /* label may not exist yet */
  }
  return runCli(["getnewaddress", "bridge-reserve-public", "bech32"]);
}

/** One-off top-up address — excluded from orphan refund polling. */
export async function newReserveFundingAddress(): Promise<string> {
  return runCli(["getnewaddress", "bridge-reserve-funding", "bech32"]);
}

export function blozToUnits(amount: number): bigint {
  return BigInt(Math.round(amount * 1e8));
}

export function unitsToBloz(units: bigint): number {
  return Number(units) / 1e8;
}

export function bridgeFeeBps(): number {
  return config.bloz.bridgeFeeBps;
}

/** Amount remaining after the bridge service fee (e.g. 3.9%), floored to 8 decimals. */
export function applyBridgeFee(amountBloz: number): number {
  const net = amountBloz * (1 - config.bloz.bridgeFeeBps / 10_000);
  return Math.floor(net * 1e8) / 1e8;
}

/** Gross bridge service fee in BLOZ (floored to 8 decimals). */
export function bridgeFeeBloz(grossBloz: number): number {
  const fee = grossBloz - applyBridgeFee(grossBloz);
  return Math.floor(fee * 1e8) / 1e8;
}

export function feeBz1Address(): string | null {
  return config.bloz.feeBz1Address;
}

/** Send the bridge service fee to BRIDGE_FEE_BZ1_ADDRESS (no-op if unset). */
export async function sendBridgeFee(
  grossBloz: number,
  context: string,
  recoverSinceMs?: number
): Promise<{ txid: string; feeBloz: number } | null> {
  const addr = feeBz1Address();
  if (!addr) return null;

  const fee = bridgeFeeBloz(grossBloz);
  if (fee <= 0) return null;

  if (recoverSinceMs != null) {
    const found = await findRecentPayoutSend(addr, fee, recoverSinceMs);
    if (found) {
      console.log(`Bridge fee ${fee} BLOZ -> ${addr} (${context}) recovered (${found})`);
      return { txid: found, feeBloz: fee };
    }
  }

  const txid = await sendBloz(addr, fee);
  console.log(`Bridge fee ${fee} BLOZ -> ${addr} (${context}) (${txid})`);
  return { txid, feeBloz: fee };
}

/** wBLOZ minted for a confirmed deposit (deposit minus bridge fee). */
export function wrapMintBloz(depositedBloz: number): number {
  const net = applyBridgeFee(depositedBloz);
  if (!Number.isFinite(net) || net <= 0) {
    throw new Error(`Wrap amount too small after ${config.bloz.bridgeFeeBps / 100}% bridge fee`);
  }
  return net;
}

/** Native BLOZ sent to user after unwrap (burned minus bridge fee minus network fee). */
export function unwrapPayoutBloz(burnedBloz: number): number {
  const networkFee = Number(config.bloz.unwrapNetworkFeeBloz);
  const payout = applyBridgeFee(burnedBloz) - networkFee;
  if (!Number.isFinite(payout) || payout <= 0) {
    throw new Error(
      `Unwrap amount too small (min payout after ${config.bloz.bridgeFeeBps / 100}% bridge fee + ${networkFee} BLOZ network fee)`
    );
  }
  return Math.floor(payout * 1e8) / 1e8;
}

export function unwrapNetworkFeeBloz(): number {
  return Number(config.bloz.unwrapNetworkFeeBloz);
}

/**
 * Native BLOZ returned after failed/unclaimed wrap or orphan deposit.
 * Refunds are NOT a bridge service — only the chain network fee is deducted.
 */
export function refundPayoutBloz(depositedBloz: number): number {
  const fee = Number(config.bloz.unwrapNetworkFeeBloz);
  const payout = depositedBloz - fee;
  if (!Number.isFinite(payout) || payout <= 0) {
    throw new Error(`Refund amount too small (min payout after ${fee} BLOZ network fee)`);
  }
  return Math.floor(payout * 1e8) / 1e8;
}
