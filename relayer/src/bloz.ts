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
  const txid = await runCli([
    "sendtoaddress",
    toAddress,
    amountBloz.toFixed(8),
    "",
    "",
    "false",
    "true",
    "6",
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

export function blozToUnits(amount: number): bigint {
  return BigInt(Math.round(amount * 1e8));
}

export function unitsToBloz(units: bigint): number {
  return Number(units) / 1e8;
}

/** Native BLOZ sent to user after unwrap (burned amount minus network fee). */
export function unwrapPayoutBloz(burnedBloz: number): number {
  const fee = Number(config.bloz.unwrapNetworkFeeBloz);
  const payout = burnedBloz - fee;
  if (!Number.isFinite(payout) || payout <= 0) {
    throw new Error(`Unwrap amount too small (min payout after ${fee} BLOZ fee)`);
  }
  return Math.floor(payout * 1e8) / 1e8;
}

export function unwrapNetworkFeeBloz(): number {
  return Number(config.bloz.unwrapNetworkFeeBloz);
}

/** Native BLOZ returned after failed/unclaimed wrap or orphan deposit (minus network fee). */
export function refundPayoutBloz(depositedBloz: number): number {
  return unwrapPayoutBloz(depositedBloz);
}
