/* global ethers */
(function () {
  "use strict";

  const BSC_CHAIN_ID = "0x38"; // 56 — overridden from /api/status when different
  const BSC_RPC_URLS = [
    "https://bsc-dataseed.binance.org/",
    "https://bsc-dataseed1.binance.org/",
    "https://bsc-dataseed2.binance.org/",
    "https://bsc.publicnode.com",
  ];
  const WBLOZ_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
  ];
  const BRIDGE_ABI = [
    "function unwrap(uint256 amount, string bz1Address)",
  ];
  const CLAIM_ABI = [
    "function claim(address to, uint256 amount, bytes32 wrapId, uint256 deadline, bytes signature)",
  ];

  let provider = null;
  let readProvider = null;
  let signer = null;
  let account = null;
  let status = null;
  let unwrapInFlight = false;
  let pollTimer = null;

  const $ = (id) => document.getElementById(id);

  function wrapDepositRules(minWrap) {
    return `<ul class="wrap-rules">
      <li>Send <strong>exactly one</strong> transaction to this address.</li>
      <li>Any amount ≥ <strong>${minWrap} BLOZ</strong> — you receive <strong>${(100 - bridgeFeePct()).toFixed(1)}%</strong> as wBLOZ (<strong>${bridgeFeePct().toFixed(1)}% bridge fee</strong>).</li>
      <li>Do <strong>not</strong> send a second transaction. Finish this wrap or wait until it expires, then create a new address.</li>
    </ul>`;
  }

  function getActiveWrap(requests, minConf) {
    return requests?.find((w) => {
      if (w.status === "minted" || w.status === "refunded" || w.status === "refunding" || w.status === "expired") {
        return false;
      }
      if (w.mint_tx_hash) return false;
      if (w.status === "claimable") return true;
      if (w.status === "pending") {
        if (w.deposit && isReadyToClaim(w, minConf)) return true;
        return !isWrapExpired(w);
      }
      return false;
    });
  }

  function isWrapExpired(w) {
    return w.status === "expired" || (w.expires_at && Date.now() > w.expires_at);
  }

  function updateCreateWrapButton(requests, minConf) {
    const btn = $("create-wrap");
    if (!btn || !account) return;
    const active = getActiveWrap(requests, minConf);
    if (active) {
      btn.disabled = true;
      if (isReadyToClaim(active, minConf)) {
        btn.textContent = "Deposit ready — claim wBLOZ below";
      } else if (active.deposit) {
        btn.textContent = "Deposit detected — waiting for confirmations";
      } else {
        btn.textContent = "Deposit address active — send BLOZ or wait";
      }
    } else {
      btn.disabled = false;
      btn.textContent = "Create deposit address";
    }
  }

  function getActiveUnwrap(requests) {
    return requests?.find((u) => u.status === "pending" || u.status === "sending");
  }

  function updateUnwrapButton(requests) {
    const btn = $("do-unwrap");
    if (!btn || !account) return;
    if (unwrapInFlight) {
      btn.disabled = true;
      return;
    }
    const active = getActiveUnwrap(requests);
    if (active) {
      btn.disabled = true;
      btn.textContent = active.status === "sending" ? "Sending BLOZ…" : "Unwrap processing…";
    } else {
      btn.disabled = false;
      btn.textContent = "Unwrap to BLOZ";
    }
  }

  function renderWrapResult(req, minConf, minWrap, reused) {
    const reusedNote = reused
      ? `<p class="wrap-hint">You already have an active deposit address — use it below. A new address is only created after this wrap completes or expires.</p>`
      : "";
    $("wrap-result").hidden = false;
    $("wrap-result").innerHTML =
      `${reusedNote}` +
      `<strong>Send BLOZ to:</strong><br><code>${req.depositAddress}</code><br><br>` +
      wrapDepositRules(minWrap) +
      `<p class="wrap-meta">Min ${req.minAmount ?? minWrap} BLOZ · ${req.minConfirmations ?? minConf} confirmations · ` +
      `Expires: ${new Date(req.expiresAt).toLocaleString()}</p>`;
  }

  function unwrapNetworkFee() {
    return Number(status?.unwrapNetworkFeeBloz ?? 0.00001);
  }

  function bridgeFeeBps() {
    return Number(status?.bridgeFeeBps ?? 390);
  }

  function bridgeFeePct() {
    return bridgeFeeBps() / 100;
  }

  function applyBridgeFee(amount) {
    return Math.floor(amount * (1 - bridgeFeeBps() / 10000) * 1e8) / 1e8;
  }

  function calcWrapMint(deposited) {
    const net = applyBridgeFee(deposited);
    if (!Number.isFinite(net) || net <= 0) return null;
    return net;
  }

  function calcUnwrapPayout(burned) {
    const payout = applyBridgeFee(burned) - unwrapNetworkFee();
    if (!Number.isFinite(payout) || payout <= 0) return null;
    return Math.floor(payout * 1e8) / 1e8;
  }

  function updateUnwrapFeeUi() {
    const fee = unwrapNetworkFee();
    const feeEl = $("unwrap-fee-note");
    if (feeEl) {
      feeEl.textContent =
        `Deducted from payout: ${bridgeFeePct().toFixed(1)}% bridge fee + ${fee.toFixed(8)} BLOZ network fee.`;
    }
    updateUnwrapEstimate();
  }

  function updateUnwrapEstimate() {
    const el = $("unwrap-estimate");
    if (!el) return;
    const amountStr = $("unwrap-amount")?.value.trim();
    if (!amountStr || Number(amountStr) <= 0) {
      el.hidden = true;
      return;
    }
    const burned = Number(amountStr);
    const payout = calcUnwrapPayout(burned);
    if (payout == null) {
      el.hidden = false;
      el.textContent = `Amount too small — payout must stay above zero after the ${bridgeFeePct().toFixed(1)}% bridge fee and ${unwrapNetworkFee().toFixed(8)} BLOZ network fee.`;
      return;
    }
    el.hidden = false;
    el.innerHTML =
      `You burn <strong>${burned.toFixed(8)} wBLOZ</strong> → receive about ` +
      `<strong>${payout.toFixed(8)} BLOZ</strong> on Block Zero ` +
      `(${bridgeFeePct().toFixed(1)}% bridge fee + ${unwrapNetworkFee().toFixed(8)} network fee deducted).`;
  }

  function rpcErrorHint(err) {
    const msg = String(err?.message || err || "");
    const code = err?.code ?? err?.error?.code;
    const httpStatus = err?.error?.data?.httpStatus ?? err?.data?.httpStatus;
    if (httpStatus === 401 || msg.includes("401") || msg.includes("Unauthorized")) {
      return "MetaMask could not reach your BSC RPC (401 Unauthorized). " +
        "Open MetaMask → Settings → Networks → BNB Smart Chain → set RPC URL to " +
        "https://bsc-dataseed.binance.org/ (or another public BSC endpoint), then reload and connect again.";
    }
    if (code === 4902) return msg;
    return msg || "Wallet connection failed.";
  }

  function getReadProvider() {
    if (!readProvider) {
      readProvider = new ethers.FallbackProvider(
        BSC_RPC_URLS.map((url, i) => ({
          provider: new ethers.JsonRpcProvider(url, 56),
          priority: i,
          stallTimeout: 2500,
        }))
      );
    }
    return readProvider;
  }

  function bscAddrLink(addr) {
    if (!addr || !status?.explorerBsc) return `<code>${addr}</code>`;
    return `<a href="${status.explorerBsc}/address/${addr}" target="_blank" rel="noopener"><code>${addr}</code></a>`;
  }

  function blozAddrLink(addr) {
    if (!addr || !status?.explorerBloz) return `<code>${addr}</code>`;
    return `<a href="${status.explorerBloz}/address/${addr}" target="_blank" rel="noopener"><code>${addr}</code></a>`;
  }

  async function loadStatus() {
    const r = await fetch("/api/status");
    status = await r.json();
    $("min-conf").textContent = status.confirmations;
    const claimDays = Math.round((status.claimExpiryHours ?? 168) / 24);
    const claimEl = $("claim-expiry-hours");
    if (claimEl) claimEl.textContent = String(claimDays);
    const updated = status.updatedAt
      ? ` · updated ${new Date(status.updatedAt).toLocaleTimeString()}`
      : "";
    $("reserves").innerHTML =
      `Bridge reserve: <strong>${Number(status.bridgeBloz).toFixed(4)} BLOZ</strong> · ` +
      `wBLOZ supply: <strong>${status.wBLOZSupply}</strong> · ` +
      (status.backed ? "✓ fully backed" : "⚠ check reserves") +
      updated;
    $("contract-info").innerHTML =
      `<dt>wBLOZ</dt><dd>${bscAddrLink(status.wBLOZ)}</dd>` +
      `<dt>Bridge</dt><dd>${bscAddrLink(status.bridge)}</dd>` +
      (status.wrapClaim ? `<dt>Wrap claim</dt><dd>${bscAddrLink(status.wrapClaim)}</dd>` : "") +
      `<dt>Min wrap</dt><dd>${status.minWrapBloz} BLOZ</dd>`;
    const trust = $("trust-info");
    if (trust) {
      trust.innerHTML =
        `<dt>Reserve wallet</dt><dd>${status.publicReserveBz1 ? blozAddrLink(status.publicReserveBz1) : "bridge wallet (HD)"}</dd>` +
        `<dt>Claim signer</dt><dd>${status.claimSigner ? bscAddrLink(status.claimSigner) : "—"}</dd>` +
        `<dt>Deployer</dt><dd>${status.deployer ? bscAddrLink(status.deployer) : "—"}</dd>` +
        `<dt>Claim window</dt><dd>${claimDays} days after deposit confirms</dd>` +
        `<dt>Bridge fee</dt><dd>${bridgeFeePct().toFixed(1)}% per wrap and unwrap` +
        (status.feeBz1Address ? ` → ${blozAddrLink(status.feeBz1Address)}` : "") +
        `</dd>` +
        `<dt>Network fee</dt><dd>${Number(status.refundNetworkFeeBloz ?? status.unwrapNetworkFeeBloz ?? 0.00001).toFixed(8)} BLOZ per payout / refund</dd>`;
    }
    const tl = $("trust-links");
    if (tl) {
      const gh = status.github
        ? `<a href="${status.github}" target="_blank" rel="noopener">GitHub</a>`
        : "GitHub";
      const docs = status.docs
        ? `<a href="${status.docs}" target="_blank" rel="noopener">Bridge guide</a>`
        : "Bridge guide";
      tl.innerHTML =
        `${gh} · ${docs} · ` +
        `<a href="https://bscscan.com/address/${status.wBLOZ}#code" target="_blank" rel="noopener">wBLOZ verified</a> · ` +
        `No third-party audit yet — review source on BscScan before large amounts.`;
    }
    const tc = $("token-contract");
    if (tc) tc.textContent = status.wBLOZ;
    updateUnwrapFeeUi();
  }

  async function addTokenToWallet() {
    if (!window.ethereum) {
      alert("Connect MetaMask first.");
      return;
    }
    if (!status?.wBLOZ) await loadStatus();
    try {
      await ensureBscNetwork(status.chainId || 56);
      const added = await window.ethereum.request({
        method: "wallet_watchAsset",
        params: {
          type: "ERC20",
          options: {
            address: status.wBLOZ,
            symbol: "wBLOZ",
            decimals: 8,
          },
        },
      });
      if (!added) alert("Token import was cancelled in MetaMask.");
    } catch (e) {
      alert(e.message || "Could not add token. Use manual import with the contract address above.");
    }
  }

  function copyTokenAddress() {
    if (!status?.wBLOZ) return;
    navigator.clipboard.writeText(status.wBLOZ).then(
      () => { $("copy-token").textContent = "Copied!"; setTimeout(() => { $("copy-token").textContent = "Copy contract address"; }, 2000); },
      () => alert("Copy failed — select the address above manually.")
    );
  }

  async function ensureBscNetwork(chainIdDec) {
    const hex = "0x" + chainIdDec.toString(16);
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hex }],
      });
    } catch (e) {
      if (e.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: hex,
            chainName: "BNB Smart Chain",
            nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
            rpcUrls: BSC_RPC_URLS,
            blockExplorerUrls: ["https://bscscan.com"],
          }],
        });
      } else throw e;
    }
  }

  async function connect() {
    if (!window.ethereum) {
      alert("Install MetaMask or another Web3 wallet.");
      return;
    }
    await loadStatus();
    await ensureBscNetwork(status.chainId || 56);
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    account = await signer.getAddress();
    readProvider = null;
    $("connect").textContent = account.slice(0, 6) + "…" + account.slice(-4);
    $("create-wrap").disabled = false;
    $("do-unwrap").disabled = false;
    refreshHistory();
    refreshUnwrapBalance();
    refreshUnwrapHistory();
  }

  $("connect").addEventListener("click", () => connect().catch((e) => alert(rpcErrorHint(e))));

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const t = btn.dataset.tab;
      $("panel-wrap").hidden = t !== "wrap";
      $("panel-unwrap").hidden = t !== "unwrap";
      if (t === "unwrap" && account) {
        refreshUnwrapBalance().catch(() => {});
        refreshUnwrapHistory().catch(() => {});
      }
    });
  });

  $("create-wrap").addEventListener("click", async () => {
    if (!account) return;
    $("create-wrap").disabled = true;
    try {
      const r = await fetch("/api/wrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evmAddress: account }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Request failed");
      const req = data.request;
      const minConf = req.minConfirmations ?? status?.confirmations ?? 6;
      const minWrap = req.minAmount ?? status?.minWrapBloz ?? 0.01;
      renderWrapResult(req, minConf, minWrap, Boolean(data.reused));
      refreshHistory();
    } catch (e) {
      alert(e.message);
    } finally {
      refreshHistory().catch(() => {});
    }
  });

  function fmtDate(ts) {
    return new Date(ts).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  function statusLabel(st) {
    if (st === "pending") return "Pending";
    if (st === "claimable") return "Ready to claim";
    if (st === "minted") return "Completed";
    if (st === "expired") return "Expired";
    if (st === "refunding") return "Refunding";
    if (st === "refunded") return "Refunded";
    return st;
  }

  function isReadyToClaim(w, minConf) {
    if (w.status === "minted" || w.mint_tx_hash) return false;
    if (w.status === "refunded" || w.status === "refunding" || w.status === "expired") return false;
    if (w.status === "claimable") return true;
    if (w.status !== "pending" || !w.deposit) return false;
    return (w.deposit.confirmations ?? 0) >= minConf;
  }

  function pendingMessage(w, minConf, minWrap) {
    const dep = w.deposit;
    const min = minWrap ?? status?.minWrapBloz ?? 0.01;
    if (w.status === "claimable") {
      const claimBy = w.claim_expires_at
        ? ` Claim by <strong>${fmtDate(w.claim_expires_at)}</strong> or BLOZ is auto-refunded.`
        : "";
      const gross = Number(w.bloz_amount ?? dep?.amount ?? 0);
      const mint = calcWrapMint(gross);
      return `Deposit confirmed: <strong>${gross.toFixed(8)} BLOZ</strong>. ` +
        `You receive <strong>${mint != null ? mint.toFixed(8) : "?"} wBLOZ</strong> (after ${bridgeFeePct().toFixed(1)}% bridge fee). ` +
        `Click <strong>Claim wBLOZ</strong> below — you pay a small BNB gas fee in MetaMask.${claimBy}`;
    }
    if (w.status !== "pending") return "";
    if (!dep) {
      return "Waiting for your BLOZ deposit. Send native BLOZ from your Block Zero wallet to the deposit address below." +
        wrapDepositRules(min);
    }
    const conf = dep.confirmations ?? 0;
    const need = minConf ?? status?.confirmations ?? 6;
    if (conf < need) {
      return `Deposit detected: <strong>${Number(dep.amount).toFixed(8)} BLOZ</strong> · ` +
        `<strong>${conf}/${need}</strong> confirmations. You can claim wBLOZ once confirmed.`;
    }
    const mint = calcWrapMint(Number(dep.amount));
    return `Deposit confirmed: <strong>${Number(dep.amount).toFixed(8)} BLOZ</strong>. ` +
      `You receive <strong>${mint != null ? mint.toFixed(8) : "?"} wBLOZ</strong> (after ${bridgeFeePct().toFixed(1)}% bridge fee). ` +
      `Click <strong>Claim wBLOZ</strong> below — you pay a small BNB gas fee in MetaMask.`;
  }

  async function claimWrap(wrapId, btn) {
    if (!signer || !account) {
      alert("Connect MetaMask first.");
      return;
    }
    if (!status?.wrapClaim) {
      alert("Claim contract not live yet. Try again in a few minutes.");
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Preparing claim…";
    }
    try {
      const r = await fetch("/api/wrap/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wrapId, evmAddress: account }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Claim signature failed");

      const claim = data.claim;
      const claimContract = new ethers.Contract(claim.contract, CLAIM_ABI, signer);
      if (btn) btn.textContent = "Confirm in MetaMask…";
      const tx = await claimContract.claim(
        claim.to,
        BigInt(claim.amount),
        claim.wrapId,
        BigInt(claim.deadline),
        claim.signature
      );
      if (btn) btn.textContent = "Waiting for BSC…";
      await tx.wait();
      await fetch("/api/wrap/confirm-mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wrapId, evmAddress: account, mintTxHash: tx.hash }),
      });
      await refreshHistory();
      scheduleFastPoll(120000);
      alert("wBLOZ claimed successfully. Add the token in MetaMask if you do not see it yet.");
    } catch (e) {
      alert(e.reason || e.message || String(e));
      await refreshHistory();
    }
  }

  function renderWrapCard(w, minConf, minWrap) {
    const dep = w.deposit;
    const blozTx = w.bloz_txid || dep?.txid;
    const blozExplorer = blozTx
      ? `https://explorer.bloz.org/tx/${blozTx}`
      : null;
    const mintLink = w.mint_tx_hash
      ? `<a href="https://bscscan.com/tx/${w.mint_tx_hash}" target="_blank" rel="noopener">View on BscScan</a>`
      : "";

    let detailRows = `
      <div class="wrap-row">
        <span class="wrap-label">Deposit address</span>
        <code class="wrap-value">${w.deposit_address}</code>
        <button type="button" class="btn btn-small copy-dep" data-copy="${w.deposit_address}">Copy</button>
      </div>
      <div class="wrap-row">
        <span class="wrap-label">Created</span>
        <span class="wrap-value">${fmtDate(w.created_at)}</span>
      </div>
      <div class="wrap-row">
        <span class="wrap-label">Expires</span>
        <span class="wrap-value">${fmtDate(w.expires_at)}</span>
      </div>`;

    if (w.status === "pending" && dep) {
      detailRows += `
      <div class="wrap-row">
        <span class="wrap-label">Detected deposit</span>
        <span class="wrap-value"><strong>${Number(dep.amount).toFixed(8)} BLOZ</strong></span>
      </div>
      <div class="wrap-row">
        <span class="wrap-label">Confirmations</span>
        <span class="wrap-value"><strong>${dep.confirmations}/${minConf}</strong></span>
      </div>`;
    }

    if (w.status === "minted" && w.bloz_amount != null) {
      const minted = calcWrapMint(Number(w.bloz_amount));
      detailRows += `
      <div class="wrap-row">
        <span class="wrap-label">Deposited</span>
        <span class="wrap-value"><strong>${Number(w.bloz_amount).toFixed(8)} BLOZ</strong></span>
      </div>
      <div class="wrap-row">
        <span class="wrap-label">Wrapped amount</span>
        <span class="wrap-value"><strong>${minted != null ? minted.toFixed(8) : Number(w.bloz_amount).toFixed(8)} wBLOZ</strong> (after ${bridgeFeePct().toFixed(1)}% fee)</span>
      </div>`;
    }

    const links = [];
    if (blozExplorer) {
      links.push(`<a href="${blozExplorer}" target="_blank" rel="noopener">BLOZ deposit tx</a>`);
    }
    if (w.refund_txid) {
      links.push(`<a href="https://explorer.bloz.org/tx/${w.refund_txid}" target="_blank" rel="noopener">Refund tx</a>`);
    }
    if (mintLink) links.push(mintLink);

    const fee = unwrapNetworkFee();
    const hint = w.status === "minted"
      ? `<p class="wrap-hint wrap-hint--ok">Claim complete. Import wBLOZ in MetaMask if you do not see it yet.</p>`
      : w.status === "refunded"
        ? `<p class="wrap-hint wrap-hint--ok">BLOZ refunded to <code>${w.refund_bz1 ?? "sender"}</code>` +
          `${w.refund_amount != null ? ` (<strong>${Number(w.refund_amount).toFixed(8)} BLOZ</strong> after ${fee.toFixed(8)} fee)` : ""}.</p>`
        : w.status === "refunding"
          ? `<p class="wrap-hint">Auto-refund in progress — returning BLOZ to the original sender minus network fee.</p>`
          : w.status === "expired"
            ? `<p class="wrap-hint wrap-hint--warn">This deposit address expired before a valid deposit was received. ` +
              `If you already sent BLOZ, it will be auto-refunded to your sending address.</p>`
            : `<div class="wrap-hint${isReadyToClaim(w, minConf) ? " wrap-hint--ok" : ""}">${pendingMessage(w, minConf, minWrap)}</div>`;

    const claimBtn = isReadyToClaim(w, minConf)
      ? `<div class="wrap-actions">
          <button type="button" class="btn btn-primary claim-wrap" data-wrap-id="${w.id}">Claim wBLOZ</button>
          <span class="wrap-meta">You pay BNB gas · ${bridgeFeePct().toFixed(1)}% bridge fee</span>
        </div>`
      : "";

    return `
      <article class="wrap-card wrap-card--${w.status === "claimable" || isReadyToClaim(w, minConf) ? "claimable" : w.status}">
        <header class="wrap-card-head">
          <span class="wrap-badge wrap-badge--${w.status === "claimable" || isReadyToClaim(w, minConf) ? "claimable" : w.status}">${isReadyToClaim(w, minConf) && w.status === "pending" ? "Ready to claim" : statusLabel(w.status)}</span>
          ${w.status === "pending" && !dep ? `<span class="wrap-meta">Min ${minWrap} BLOZ · ${minConf} conf</span>` : ""}
        </header>
        ${hint}
        <div class="wrap-details">${detailRows}</div>
        ${claimBtn}
        ${links.length ? `<div class="wrap-links">${links.join(" · ")}</div>` : ""}
      </article>`;
  }

  function bindWrapActions(root) {
    root.querySelectorAll(".claim-wrap").forEach((btn) => {
      btn.addEventListener("click", () => claimWrap(btn.dataset.wrapId, btn).catch((e) => alert(e.message)));
    });
  }

  function bindCopyButtons(root) {
    root.querySelectorAll(".copy-dep").forEach((btn) => {
      btn.addEventListener("click", () => {
        const text = btn.dataset.copy;
        if (!text) return;
        navigator.clipboard.writeText(text).then(
          () => {
            btn.textContent = "Copied!";
            setTimeout(() => { btn.textContent = "Copy"; }, 2000);
          },
          () => alert("Copy failed — select the address manually.")
        );
      });
    });
  }

  async function refreshHistory() {
    if (!account) return;
    const r = await fetch("/api/wrap?evmAddress=" + encodeURIComponent(account));
    const data = await r.json();
    const el = $("wrap-history");
    const minConf = data.minConfirmations ?? status?.confirmations ?? 6;
    const minWrap = data.minWrapBloz ?? status?.minWrapBloz ?? 0.01;
    updateCreateWrapButton(data.requests ?? [], minConf);

    if (!data.requests?.length) {
      el.innerHTML = "";
      $("wrap-result").hidden = true;
      return;
    }

    el.innerHTML =
      `<div class="wrap-history-head">
        <h2 class="wrap-history-title">Your wrap requests</h2>
        <p class="wrap-history-sub">Status updates every 30 seconds. Keep this page open or reconnect your wallet to check progress.</p>
      </div>
      <div class="wrap-list">${data.requests.map((w) => renderWrapCard(w, minConf, minWrap)).join("")}</div>`;
    bindCopyButtons(el);
    bindWrapActions(el);

    const active = getActiveWrap(data.requests, minConf);
    if (active) {
      $("wrap-result").hidden = false;
      const statusLine = active.deposit
        ? pendingMessage(active, minConf, minWrap)
        : "Waiting for your BLOZ deposit. Send native BLOZ from your Block Zero wallet to the address above.";
      $("wrap-result").innerHTML =
        `<strong>Active deposit address</strong> (also listed below)<br>` +
        `<code>${active.deposit_address}</code><br><br>` +
        wrapDepositRules(minWrap) +
        `<p class="wrap-meta">${statusLine}</p>`;
    } else {
      $("wrap-result").hidden = true;
    }
  }

  function isValidBz1(addr) {
    return addr.startsWith("bz1") && addr.length >= 14 && !/\s/.test(addr);
  }

  async function refreshUnwrapBalance() {
    const el = $("unwrap-balance");
    if (!el) return;
    if (!account || !status?.wBLOZ || !provider) {
      el.textContent = "Connect wallet to see your wBLOZ balance.";
      return;
    }
    try {
      const wBLOZ = new ethers.Contract(status.wBLOZ, WBLOZ_ABI, getReadProvider());
      const [bal, decimals] = await Promise.all([wBLOZ.balanceOf(account), wBLOZ.decimals()]);
      const formatted = ethers.formatUnits(bal, decimals);
      el.innerHTML = `Your wBLOZ balance: <strong>${formatted}</strong>`;
    } catch {
      el.textContent = "Could not load wBLOZ balance.";
    }
  }

  function unwrapStatusLabel(st) {
    if (st === "pending") return "Processing";
    if (st === "sending") return "Sending BLOZ";
    if (st === "sent") return "Completed";
    if (st === "failed") return "Failed";
    return st;
  }

  function renderUnwrapCard(u) {
    const fee = u.networkFeeBloz ?? unwrapNetworkFee();
    const payout = u.payoutBloz ?? calcUnwrapPayout(u.amountBloz);
    const blozLink = u.bloz_txid
      ? `<a href="https://explorer.bloz.org/tx/${u.bloz_txid}" target="_blank" rel="noopener">BLOZ payout tx</a>`
      : "";
    const hint = u.status === "sending"
      ? `<p class="wrap-hint">Sending <strong>${payout != null ? payout.toFixed(8) : "?"} BLOZ</strong> to <code>${u.bz1_address}</code>…</p>`
      : u.status === "pending"
      ? `<p class="wrap-hint">Unwrap confirmed on BSC (${Number(u.amountBloz).toFixed(8)} wBLOZ burned). ` +
        `Payout target: <strong>${payout != null ? payout.toFixed(8) : "?"} BLOZ</strong> to <code>${u.bz1_address}</code> ` +
        `(after ${bridgeFeePct().toFixed(1)}% bridge fee + ${fee.toFixed(8)} BLOZ network fee). ` +
        `Native payouts usually arrive within a few minutes; during high load it can take longer.</p>`
      : u.status === "sent"
        ? `<p class="wrap-hint wrap-hint--ok">Sent <strong>${Number(u.payout_bloz ?? payout ?? u.amountBloz).toFixed(8)} BLOZ</strong> ` +
        `to <code>${u.bz1_address}</code> (${Number(u.amountBloz).toFixed(8)} wBLOZ burned, ${bridgeFeePct().toFixed(1)}% bridge fee + ${fee.toFixed(8)} network fee deducted).</p>`
        : `<p class="wrap-hint wrap-hint--warn">Payout failed — check your bz1 address and try again or contact support.</p>`;

    return `
      <article class="wrap-card wrap-card--${u.status === "sent" ? "minted" : u.status === "failed" ? "expired" : "pending"}">
        <header class="wrap-card-head">
          <span class="wrap-badge wrap-badge--${u.status === "sent" ? "minted" : u.status === "failed" ? "expired" : u.status === "sending" ? "claimable" : "pending"}">${unwrapStatusLabel(u.status)}</span>
          <span class="wrap-meta">#${u.unwrap_id}</span>
        </header>
        ${hint}
        <div class="wrap-details">
          <div class="wrap-row">
            <span class="wrap-label">wBLOZ burned</span>
            <span class="wrap-value"><strong>${Number(u.amountBloz).toFixed(8)}</strong></span>
          </div>
          <div class="wrap-row">
            <span class="wrap-label">BLOZ payout</span>
            <span class="wrap-value"><strong>${payout != null ? payout.toFixed(8) : "—"}</strong></span>
          </div>
          <div class="wrap-row">
            <span class="wrap-label">Bridge fee</span>
            <span class="wrap-value">${bridgeFeePct().toFixed(1)}%</span>
          </div>
          <div class="wrap-row">
            <span class="wrap-label">Network fee</span>
            <span class="wrap-value">${fee.toFixed(8)} BLOZ</span>
          </div>
          <div class="wrap-row">
            <span class="wrap-label">Receive address</span>
            <code class="wrap-value">${u.bz1_address}</code>
          </div>
          <div class="wrap-row">
            <span class="wrap-label">Requested</span>
            <span class="wrap-value">${fmtDate(u.created_at)}</span>
          </div>
        </div>
        ${blozLink ? `<div class="wrap-links">${blozLink}</div>` : ""}
      </article>`;
  }

  async function refreshUnwrapHistory() {
    if (!account) return;
    const el = $("unwrap-history");
    if (!el) return;
    const r = await fetch("/api/unwrap?evmAddress=" + encodeURIComponent(account));
    const data = await r.json();
    updateUnwrapButton(data.requests ?? []);
    if (!data.requests?.length) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML =
      `<div class="wrap-history-head">
        <h2 class="wrap-history-title">Your unwrap requests</h2>
        <p class="wrap-history-sub">Status updates every 30 seconds after you confirm unwrap on BSC.</p>
      </div>
      <div class="wrap-list">${data.requests.map(renderUnwrapCard).join("")}</div>`;
  }

  $("do-unwrap").addEventListener("click", async () => {
    if (!signer || !status) return;
    const amountStr = $("unwrap-amount").value.trim();
    const bz1 = $("unwrap-bz1").value.trim();
    if (!amountStr || Number(amountStr) <= 0) {
      alert("Enter a valid wBLOZ amount.");
      return;
    }
    if (!isValidBz1(bz1)) {
      alert("Enter a valid Block Zero address starting with bz1 (at least 14 characters).");
      return;
    }
    const payout = calcUnwrapPayout(Number(amountStr));
    if (payout == null) {
      alert(`Amount too small. Payout must stay above zero after the ${bridgeFeePct().toFixed(1)}% bridge fee and ${unwrapNetworkFee().toFixed(8)} BLOZ network fee.`);
      return;
    }
    if (Number(amountStr) > Number(status.bridgeBloz ?? 0)) {
      const ok = confirm(
        `Bridge reserve is ${Number(status.bridgeBloz ?? 0).toFixed(4)} BLOZ — less than your unwrap amount. ` +
        "The relayer may delay payout until reserves are topped up. Continue anyway?"
      );
      if (!ok) return;
    }
    unwrapInFlight = true;
    $("do-unwrap").disabled = true;
    $("do-unwrap").textContent = "Confirm in MetaMask…";
    $("unwrap-status").hidden = false;
    try {
      const wBLOZ = new ethers.Contract(status.wBLOZ, WBLOZ_ABI, signer);
      const bridge = new ethers.Contract(status.bridge, BRIDGE_ABI, signer);
      const decimals = await wBLOZ.decimals();
      const amount = ethers.parseUnits(amountStr, decimals);
      const balance = await wBLOZ.balanceOf(account);
      if (balance < amount) {
        throw new Error("Insufficient wBLOZ balance in your wallet.");
      }
      const allowance = await wBLOZ.allowance(account, status.bridge);
      if (allowance < amount) {
        $("unwrap-status").textContent = "Step 1/2: Approving wBLOZ in MetaMask…";
        const txA = await wBLOZ.approve(status.bridge, amount);
        await txA.wait();
      }
      $("unwrap-status").textContent = "Step 2/2: Confirm unwrap in MetaMask…";
      const tx = await bridge.unwrap(amount, bz1);
      $("unwrap-status").innerHTML =
        `Unwrap submitted: <a href="https://bscscan.com/tx/${tx.hash}" target="_blank" rel="noopener">View on BscScan</a><br>` +
        `You will receive about <strong>${payout.toFixed(8)} BLOZ</strong> at <code>${bz1}</code> ` +
        `( ${Number(amountStr).toFixed(8)} wBLOZ burned, ${bridgeFeePct().toFixed(1)}% bridge fee + ${unwrapNetworkFee().toFixed(8)} network fee deducted ).`;
      await tx.wait();
      $("unwrap-status").innerHTML +=
        `<br><br>Confirmed on BSC. Payout usually follows within a few minutes — see <strong>Your unwrap requests</strong> below.`;
      await refreshUnwrapBalance();
      scheduleFastPoll(180000);
      setTimeout(() => refreshUnwrapHistory().catch(() => {}), 3000);
      await refreshUnwrapHistory();
    } catch (e) {
      $("unwrap-status").innerHTML =
        `<span style="color:#ff8a8a">Unwrap failed: ${e.reason || e.message || e}</span>`;
      alert(e.reason || e.message || e);
    } finally {
      unwrapInFlight = false;
      refreshUnwrapHistory().catch(() => {});
    }
  });

  function scheduleFastPoll(ms) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      loadStatus().catch(() => {});
      refreshHistory().catch(() => {});
      refreshUnwrapBalance().catch(() => {});
      refreshUnwrapHistory().catch(() => {});
    }, 5000);
    setTimeout(() => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, ms);
  }

  loadStatus().catch(() => {
    $("reserves").textContent = "Could not load bridge status.";
  });
  $("add-token")?.addEventListener("click", () => addTokenToWallet().catch((e) => alert(e.message)));
  $("copy-token")?.addEventListener("click", copyTokenAddress);
  setInterval(() => {
    if (pollTimer) return;
    loadStatus().catch(() => {});
    refreshHistory().catch(() => {});
    refreshUnwrapBalance().catch(() => {});
    refreshUnwrapHistory().catch(() => {});
  }, 10000);
})();
