import type { Hex, TransactionReceipt } from "viem";

/**
 * Resilient BSC block scanning for the live event pollers.
 *
 * Public BSC RPCs are load-balanced: eth_blockNumber can come from a backend at the tip while
 * the following eth_getBlockByNumber lands on one a few blocks behind → viem BlockNotFoundError.
 * This module (a) rotates through several endpoints until one serves the block, (b) stops a scan
 * cleanly *before* a block no endpoint can serve yet — the caller's cursor then advances only to
 * the last fully scanned block, never past it — and (c) backs off with rate-limited warnings
 * instead of one error line per 12 s poll.
 *
 * No config import here so it can be unit-tested without the relayer env.
 */

export type ScanTx = { hash: Hex; to?: string | null; input: Hex };

export interface ScanRpc {
  /** Short label for logs (host only, no keys/paths). */
  name: string;
  blockNumber(): Promise<bigint>;
  blockTxs(blockNumber: bigint): Promise<ScanTx[]>;
  receipt(hash: Hex): Promise<TransactionReceipt>;
}

/** Every endpoint failed for one call — transient by assumption; the scan stops before it. */
export class RpcPoolExhausted extends Error {
  constructor(
    readonly label: string,
    readonly reason: string
  ) {
    super(`no BSC RPC could serve ${label} (${reason})`);
    this.name = "RpcPoolExhausted";
  }
}

/**
 * Coarse reason code for log lines. Deliberately never echoes viem messages: they contain words
 * like "failed"/"Error" that bridge-health counts as error lines.
 */
export function classifyRpcIssue(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "BlockNotFoundError" || /block .*could not be found/i.test(msg)) return "block-not-found";
  if (name === "TransactionReceiptNotFoundError" || /receipt .*could not be found/i.test(msg)) {
    return "receipt-not-found";
  }
  if (name === "TimeoutError" || /took too long|timed? ?out/i.test(msg)) return "timeout";
  if (/429|rate limit/i.test(msg)) return "rate-limited";
  if (/authenticate|unauthori[sz]ed|api key|403/i.test(msg)) return "unauthorized";
  if (name === "HttpRequestError" || /fetch|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(msg)) return "http";
  return "rpc";
}

/** Sticky failover: keep using the endpoint that worked last, rotate on any failure. */
export class RpcPool {
  private preferred = 0;

  constructor(readonly rpcs: ScanRpc[]) {
    if (!rpcs.length) throw new Error("RpcPool needs at least one endpoint");
  }

  get current(): string {
    return this.rpcs[this.preferred].name;
  }

  async call<T>(label: string, fn: (rpc: ScanRpc) => Promise<T>): Promise<T> {
    const issues: string[] = [];
    for (let i = 0; i < this.rpcs.length; i++) {
      const idx = (this.preferred + i) % this.rpcs.length;
      const rpc = this.rpcs[idx];
      try {
        const out = await fn(rpc);
        this.preferred = idx;
        return out;
      } catch (err) {
        issues.push(`${rpc.name}:${classifyRpcIssue(err)}`);
      }
    }
    // Next call starts at the following endpoint, so one stuck backend can't pin us.
    this.preferred = (this.preferred + 1) % this.rpcs.length;
    throw new RpcPoolExhausted(label, issues.join(", "));
  }
}

export type ScanResult<E> = {
  events: E[];
  /** Last block fully scanned (fromBlock - 1 when nothing was scanned). Cursor may advance to this. */
  scanEnd: bigint;
  /** Set when the scan stopped early: first block not yet served by any endpoint. */
  stalledAt?: bigint;
  stallReason?: string;
};

/** Per-block visitor: fetch receipts etc. through the pool; throwing RpcPoolExhausted stalls at this block. */
export type BlockVisitor<E> = (pool: RpcPool, blockNumber: bigint, txs: ScanTx[]) => Promise<E[]>;

/**
 * Scan [fromBlock, toBlock] block by block. A block's events are only kept once the whole block
 * (incl. receipts) was read, and the scan never continues past a block it could not read —
 * so scanEnd is always a safe cursor target.
 */
export async function scanBlockRange<E>(
  pool: RpcPool,
  fromBlock: bigint,
  toBlock: bigint,
  visit: BlockVisitor<E>,
  pauseMs = 40,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<ScanResult<E>> {
  const events: E[] = [];
  for (let b = fromBlock; b <= toBlock; b++) {
    try {
      const txs = await pool.call(`block ${b}`, (rpc) => rpc.blockTxs(b));
      events.push(...(await visit(pool, b, txs)));
    } catch (err) {
      if (!(err instanceof RpcPoolExhausted)) throw err;
      return { events, scanEnd: b - 1n, stalledAt: b, stallReason: err.reason };
    }
    if (b < toBlock && pauseMs > 0) await sleep(pauseMs);
  }
  return { events, scanEnd: toBlock };
}

/**
 * Safe scan target: tip minus lag. The tip comes from whichever endpoint answers; staying a few
 * blocks behind means even a slightly lagging backend already has the block.
 */
export async function scanTarget(pool: RpcPool, lagBlocks: bigint): Promise<bigint> {
  const latest = await pool.call("block number", (rpc) => rpc.blockNumber());
  return latest > lagBlocks ? latest - lagBlocks : 0n;
}

export type StallGateOptions = {
  /** First retry delay after a stall (normally the poll interval). */
  baseDelayMs: number;
  /** Cap for the exponential backoff. */
  maxDelayMs: number;
  /** Continuous stall longer than this → one console.error per period (cursor really stuck). */
  escalateAfterMs: number;
  /** Minimum gap between warning lines. */
  warnEveryMs?: number;
  now?: () => number;
  log?: { warn: (msg: string) => void; error: (msg: string) => void; info: (msg: string) => void };
};

/**
 * Backoff + log throttling for one poller stream (unwrap / claim). While backing off the poller
 * simply does not scan — the cursor stays where it is, nothing is skipped.
 */
export class StallGate {
  private consecutive = 0;
  private nextAttemptAt = 0;
  private stalledSince: number | null = null;
  private lastWarnAt = -Infinity;
  private lastEscalateAt = -Infinity;
  private suppressed = 0;
  private readonly now: () => number;
  private readonly log: NonNullable<StallGateOptions["log"]>;
  private readonly warnEveryMs: number;

  constructor(
    readonly stream: string,
    private readonly opts: StallGateOptions
  ) {
    this.now = opts.now ?? Date.now;
    this.warnEveryMs = opts.warnEveryMs ?? 60_000;
    this.log = opts.log ?? {
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
      info: (m) => console.log(m),
    };
  }

  /** False while backing off — caller skips this poll. */
  ready(): boolean {
    return this.now() >= this.nextAttemptAt;
  }

  get stalled(): boolean {
    return this.stalledSince !== null;
  }

  /** Scan stopped before `block` (or the tip could not be read when block is undefined). */
  onStall(block: bigint | undefined, reason: string, progressed: boolean): void {
    const t = this.now();
    // Partial progress → the RPCs are basically fine, just retry on the next poll.
    if (this.stalledSince === null || progressed) this.stalledSince = t;
    this.consecutive = progressed ? 1 : this.consecutive + 1;
    const delay = Math.min(this.opts.baseDelayMs * 2 ** (this.consecutive - 1), this.opts.maxDelayMs);
    this.nextAttemptAt = t + delay;

    const where = block === undefined ? "at chain tip" : `at block ${block}`;
    const stalledMs = t - this.stalledSince;
    if (stalledMs >= this.opts.escalateAfterMs && t - this.lastEscalateAt >= this.opts.escalateAfterMs) {
      this.lastEscalateAt = t;
      this.lastWarnAt = t;
      this.log.error(
        `${this.stream} scan stuck ${Math.round(stalledMs / 60_000)} min ${where} — no BSC RPC serves it (${reason}); cursor unchanged — persistent RPC error`
      );
      return;
    }
    if (t - this.lastWarnAt >= this.warnEveryMs) {
      const extra = this.suppressed ? `, ${this.suppressed} similar since last note` : "";
      this.lastWarnAt = t;
      this.suppressed = 0;
      this.log.warn(
        `${this.stream} scan paused ${where}: not yet served by BSC RPCs (${reason}); retry in ${Math.round(delay / 1000)}s, cursor unchanged${extra}`
      );
    } else {
      this.suppressed++;
    }
  }

  onSuccess(): void {
    if (this.stalledSince !== null) {
      const secs = Math.round((this.now() - this.stalledSince) / 1000);
      this.log.info(`${this.stream} scan resumed after ${secs}s`);
    }
    this.consecutive = 0;
    this.nextAttemptAt = 0;
    this.stalledSince = null;
    this.suppressed = 0;
  }
}

/** Configured endpoints first (order kept), then fallbacks; duplicates (trailing slash, case) dropped. */
export function mergeRpcUrls(primary: string[], fallbacks: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...primary, ...fallbacks]) {
    const url = raw.trim();
    if (!url) continue;
    const key = url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/** Host only — URLs may carry API keys in path or query. */
export function rpcLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
