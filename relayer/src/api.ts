import type { Express } from "express";

import type Database from "better-sqlite3";

import { isAddress } from "viem";

import { config } from "./config.js";

import {
  blozToUnits,
  bridgeFeeBps,
  unwrapNetworkFeeBloz,
  unwrapPayoutBloz,
  wrapMintBloz,
} from "./bloz.js";

import { signWrapClaim, wrapIdToBytes32 } from "./claim.js";

import {

  createWrapRequest,

  expireOldWraps,

  getActiveWrapForEvm,

  getWrapById,

  listWrapsForEvm,

  listUnwrapsForEvm,

  markWrapClaimable,

  markWrapMintedFromClaim,

  markWrapMintedOnChain,

  type WrapRequest,

} from "./db.js";

import { getDepositSenderBz1, listRecentReceives, newDepositAddress } from "./bloz.js";

import { getReserveStats } from "./watcher.js";
import { loadDeployments } from "./deployments.js";
import { isWrapClaimedOnChain } from "./bsc.js";



const evmRe = /^0x[a-fA-F0-9]{40}$/;

const uuidRe =

  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bz1Re = /^bz1[a-z0-9]{10,}$/i;



function wrapRequestPayload(wrap: WrapRequest) {

  return {

    id: wrap.id,

    depositAddress: wrap.deposit_address,

    evmAddress: wrap.evm_address,

    status: wrap.status,

    minConfirmations: config.bloz.confirmations,

    minAmount: config.bloz.minWrapBloz,

    expiresAt: wrap.expires_at,

    claimExpiresAt: wrap.claim_expires_at,

    createdAt: wrap.created_at,

    blozTxid: wrap.bloz_txid,

    blozAmount: wrap.bloz_amount,

    mintTxHash: wrap.mint_tx_hash,

    refundTxid: wrap.refund_txid,

    refundAmount: wrap.refund_amount,

    refundBz1: wrap.refund_bz1,

  };

}



function enrichWrapRows(

  rows: ReturnType<typeof listWrapsForEvm>,

  receives: Awaited<ReturnType<typeof listRecentReceives>>

) {

  const byAddress = new Map(receives.map((tx) => [tx.address, tx]));

  return rows.map((wrap) => {

    const deposit = byAddress.get(wrap.deposit_address);

    return {

      ...wrap,

      deposit: deposit

        ? {

            amount: deposit.amount,

            confirmations: deposit.confirmations,

            txid: deposit.txid,

          }

        : null,

    };

  });

}



async function ensureClaimable(

  db: Database.Database,

  wrap: NonNullable<ReturnType<typeof getWrapById>>

) {

  if (wrap.status === "claimable") return wrap;

  if (wrap.status !== "pending") return wrap;



  const receives = await listRecentReceives();

  const deposit = receives.find((tx) => tx.address === wrap.deposit_address);

  if (!deposit || deposit.confirmations < config.bloz.confirmations) return wrap;



  const min = Number(config.bloz.minWrapBloz);

  if (deposit.amount < min) return wrap;



  const claimExpiresAt = Date.now() + config.bloz.claimExpiryHours * 3600 * 1000;
  const sender = await getDepositSenderBz1(deposit.txid);
  markWrapClaimable(db, wrap.id, deposit.txid, deposit.amount, sender, claimExpiresAt);

  return getWrapById(db, wrap.id)!;

}

async function syncWrapStatuses(db: Database.Database, evmAddress: string): Promise<void> {
  const rows = listWrapsForEvm(db, evmAddress);
  for (const row of rows) {
    if (row.status !== "pending" && row.status !== "claimable") continue;
    let wrap = getWrapById(db, row.id);
    if (!wrap) continue;
    wrap = await ensureClaimable(db, wrap);
    if (wrap.status === "claimable" && (await isWrapClaimedOnChain(wrap.id))) {
      markWrapMintedOnChain(db, wrap.id);
    }
  }
}

export function registerApi(app: Express, db: Database.Database): void {

  app.get("/api/status", async (_req, res) => {

    try {

      const reserves = await getReserveStats(db);

      const dep = loadDeployments();

      const deployer = config.meta.deployerAddress ?? dep?.deployer ?? null;

      const operator = config.meta.operatorAddress ?? dep?.operator ?? null;

      res.json({

        ok: true,

        chain: "bsc",

        chainId: config.bsc.chainId,

        wBLOZ: config.bsc.wBLOZAddress,

        bridge: config.bsc.bridgeAddress,

        wrapClaim: config.bsc.wrapClaimAddress ?? null,

        claimMode: Boolean(config.bsc.wrapClaimAddress),

        claimSigner: operator,

        deployer,

        confirmations: config.bloz.confirmations,

        minWrapBloz: config.bloz.minWrapBloz,

        wrapExpiryHours: config.bloz.wrapExpiryHours,

        claimExpiryHours: config.bloz.claimExpiryHours,

        unwrapNetworkFeeBloz: config.bloz.unwrapNetworkFeeBloz,

        refundNetworkFeeBloz: config.bloz.unwrapNetworkFeeBloz,

        bridgeFeeBps: bridgeFeeBps(),

        bridgeFeePercent: bridgeFeeBps() / 100,

        github: config.meta.githubUrl,

        docs: config.meta.docsUrl,

        explorerBloz: "https://explorer.bloz.org",

        explorerBsc: "https://bscscan.com",

        model: "custodial",

        mintPath: config.bsc.wrapClaimAddress ? "claim-contract" : "relayer-mint",

        ...reserves,

      });

    } catch (err) {

      res.status(500).json({ ok: false, error: String(err) });

    }

  });



  app.post("/api/wrap", async (req, res) => {

    const evmAddress = String(req.body?.evmAddress ?? "").trim();
    const returnBz1Raw = String(req.body?.returnBz1 ?? "").trim();
    const returnBz1 = returnBz1Raw && bz1Re.test(returnBz1Raw) ? returnBz1Raw : null;

    if (!evmRe.test(evmAddress) || !isAddress(evmAddress)) {

      res.status(400).json({ ok: false, error: "Invalid EVM address" });

      return;

    }

    if (returnBz1Raw && !returnBz1) {

      res.status(400).json({ ok: false, error: "Invalid returnBz1 — must start with bz1" });

      return;

    }



    try {

      const now = Date.now();

      expireOldWraps(db, now);



      const existing = getActiveWrapForEvm(db, evmAddress, now);

      if (existing) {

        res.json({

          ok: true,

          reused: true,

          request: wrapRequestPayload(existing),

        });

        return;

      }



      const label = `wrap-${Date.now()}`;

      const depositAddress = await newDepositAddress(label);

      const expiresAt = now + config.bloz.wrapExpiryHours * 3600 * 1000;

      const wrap = createWrapRequest(db, evmAddress, depositAddress, expiresAt, returnBz1);

      res.json({

        ok: true,

        reused: false,

        request: wrapRequestPayload(wrap),

      });

    } catch (err) {

      res.status(500).json({ ok: false, error: String(err) });

    }

  });



  app.get("/api/wrap", async (req, res) => {

    const evmAddress = String(req.query.evmAddress ?? "").trim();

    if (!evmRe.test(evmAddress)) {

      res.status(400).json({ ok: false, error: "evmAddress required" });

      return;

    }

    try {

      await syncWrapStatuses(db, evmAddress);

      const receives = await listRecentReceives();

      const rows = listWrapsForEvm(db, evmAddress);

      const requests = enrichWrapRows(rows, receives);

      res.json({

        ok: true,

        requests,

        minConfirmations: config.bloz.confirmations,

        minWrapBloz: config.bloz.minWrapBloz,

        wrapClaim: config.bsc.wrapClaimAddress ?? null,

        bridgeFeeBps: bridgeFeeBps(),

      });

    } catch (err) {

      res.status(500).json({ ok: false, error: String(err) });

    }

  });

  app.post("/api/wrap/confirm-mint", async (req, res) => {
    const wrapId = String(req.body?.wrapId ?? "").trim();
    const evmAddress = String(req.body?.evmAddress ?? "").trim();
    const mintTxHash = String(req.body?.mintTxHash ?? "").trim();

    if (!uuidRe.test(wrapId)) {
      res.status(400).json({ ok: false, error: "Invalid wrapId" });
      return;
    }
    if (!evmRe.test(evmAddress) || !isAddress(evmAddress)) {
      res.status(400).json({ ok: false, error: "Invalid EVM address" });
      return;
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(mintTxHash)) {
      res.status(400).json({ ok: false, error: "Invalid mintTxHash" });
      return;
    }

    try {
      const wrap = getWrapById(db, wrapId);
      if (!wrap || wrap.evm_address !== evmAddress.toLowerCase()) {
        res.status(404).json({ ok: false, error: "Wrap request not found" });
        return;
      }
      if (wrap.status === "minted") {
        res.json({ ok: true, already: true });
        return;
      }
      markWrapMintedFromClaim(db, wrapId, mintTxHash);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post("/api/wrap/claim", async (req, res) => {

    const wrapId = String(req.body?.wrapId ?? "").trim();

    const evmAddress = String(req.body?.evmAddress ?? "").trim();



    if (!uuidRe.test(wrapId)) {

      res.status(400).json({ ok: false, error: "Invalid wrapId" });

      return;

    }

    if (!evmRe.test(evmAddress) || !isAddress(evmAddress)) {

      res.status(400).json({ ok: false, error: "Invalid EVM address" });

      return;

    }

    if (!config.bsc.wrapClaimAddress) {

      res.status(503).json({ ok: false, error: "Claim contract not configured yet" });

      return;

    }



    try {

      let wrap = getWrapById(db, wrapId);

      if (!wrap || wrap.evm_address !== evmAddress.toLowerCase()) {

        res.status(404).json({ ok: false, error: "Wrap request not found" });

        return;

      }



      wrap = await ensureClaimable(db, wrap);



      if (wrap.status === "minted") {

        res.status(409).json({ ok: false, error: "Already claimed" });

        return;

      }

      if (wrap.status === "refunding" || wrap.status === "refunded") {

        res.status(409).json({ ok: false, error: "This wrap was refunded or is being refunded" });

        return;

      }

      if (await isWrapClaimedOnChain(wrap.id)) {

        res.status(409).json({ ok: false, error: "Already claimed on-chain" });

        return;

      }

      const nowSec = Math.floor(Date.now() / 1000);
      const claimEndSec = wrap.claim_expires_at
        ? Math.floor(wrap.claim_expires_at / 1000)
        : nowSec + config.bloz.claimSigTtlSec;

      if (nowSec >= claimEndSec) {

        res.status(409).json({

          ok: false,

          error: "Claim window expired — BLOZ will be refunded to the original sender",

        });

        return;

      }

      if (wrap.status !== "claimable" || wrap.bloz_amount == null) {

        res.status(400).json({ ok: false, error: "Deposit not ready to claim yet" });

        return;

      }



      // Bridge fee: user receives deposit minus fee as wBLOZ; the fee stays
      // in the bridge reserve (keeps wBLOZ over-backed).
      const mintBloz = wrapMintBloz(wrap.bloz_amount);
      const amountUnits = blozToUnits(mintBloz);

      const deadline = Math.min(
        nowSec + config.bloz.claimSigTtlSec,
        claimEndSec
      );

      if (deadline <= nowSec) {

        res.status(409).json({ ok: false, error: "Claim window expired" });

        return;

      }

      const signature = await signWrapClaim({

        to: evmAddress as `0x${string}`,

        amountUnits,

        wrapId: wrap.id,

        deadline,

      });



      res.json({

        ok: true,

        claim: {

          contract: config.bsc.wrapClaimAddress,

          to: evmAddress,

          amount: amountUnits.toString(),

          wrapId: wrapIdToBytes32(wrap.id),

          deadline,

          signature,

          blozAmount: wrap.bloz_amount,

          mintBloz,

          bridgeFeeBps: bridgeFeeBps(),

        },

      });

    } catch (err) {

      res.status(500).json({ ok: false, error: String(err) });

    }

  });



  app.get("/api/unwrap", (req, res) => {

    const evmAddress = String(req.query.evmAddress ?? "").trim();

    if (!evmRe.test(evmAddress)) {

      res.status(400).json({ ok: false, error: "evmAddress required" });

      return;

    }

    try {

      const fee = unwrapNetworkFeeBloz();

      const requests = listUnwrapsForEvm(db, evmAddress).map((row) => {

        const amountBloz = Number(row.amount_units) / 1e8;

        let payoutBloz = row.payout_bloz;

        if (payoutBloz == null) {

          try {

            payoutBloz = unwrapPayoutBloz(amountBloz);

          } catch {

            payoutBloz = null;

          }

        }

        return {

          ...row,

          amountBloz,

          payoutBloz,

          networkFeeBloz: fee,

        };

      });

      res.json({ ok: true, requests, bridgeFeeBps: bridgeFeeBps() });

    } catch (err) {

      res.status(500).json({ ok: false, error: String(err) });

    }

  });

}


