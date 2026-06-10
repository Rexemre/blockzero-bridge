# Security — Block Zero Bridge

## Scope

- `contracts/` — wBLOZ, BlozBridge, BlozWrapClaim on BSC
- `relayer/` — deposit watcher, claim signer, unwrap payouts, auto-refunds
- `web/` — bridge.bloz.org UI

## Trust assumptions

Users trust the bridge operator to:

1. Hold enough native BLOZ to back all wBLOZ (`reserve ≥ totalSupply`)
2. Sign valid wrap claims only after confirmed deposits
3. Pay unwrap and refund payouts promptly
4. Not abuse admin `pause()` without cause

Users do **not** need to trust the operator for manual wBLOZ minting — minting goes through `BlozWrapClaim` on-chain.

## Known limitations

- **Custodial** — not a trustless light-client bridge
- **No audit** — review source and verified contracts yourself
- **Single admin** — deployer can pause contracts; no multisig/timelock yet
- **Sender resolution** — auto-refunds walk the first input of the deposit tx; coinjoin / multi-input sends may resolve wrong (optional `returnBz1` on wrap creation is safer)
- **Solvency** — operator must keep `bridge BLOZ ≥ wBLOZ supply`; there is no on-chain enforcement

## Mitigations (implemented)

| Risk | Mitigation |
|------|------------|
| Claim signature valid after claim window → mint + refund | Signature `deadline` capped at `claim_expires_at`; refunds delayed `CLAIM_SIG_TTL_SEC` after expiry; on-chain `claimed()` checked before refund |
| Double mint same wrap | `claimed` mapping on `BlozWrapClaim` |
| Wrong EVM claims wrap | API checks `evm_address` matches wrap row |
| Duplicate deposit | Second tx queued as orphan refund |
| Refund while claim pending on-chain | `isWrapClaimedOnChain()` before refund; DB synced to `minted` |
| Bridge node can't resolve sender | Bridge `bitcoind` uses `txindex=1` (no prune); sender stored at deposit time; optional `returnBz1` |

## Residual risks (operator / user)

- **Admin key compromise** — attacker can `pause()`, grant `MINTER_ROLE`, or stop payouts
- **Relayer downtime** — unwrap/refund delays; funds remain in bridge wallet
- **Fake wBLOZ token** on BSC — users must use official contract from `bridge.bloz.org`
- **No rate limits** on wrap API — griefing via many deposit addresses (low impact)

## Report a issue

Open a GitHub security advisory or contact the Block Zero maintainers via the project Discord / GitHub org.

Do **not** post exploit details publicly before a fix is available.

## Operator checklist

- Keep bridge wallet BLOZ reserve ≥ wBLOZ supply
- Verify contracts on BscScan after each deploy (`npm run verify:bsc`)
- Monitor `/api/status` — `backed` must stay `true`
- Fund operator wallet with BNB for claim signatures (off-chain only)
- Rotate keys if relayer host is compromised; pause contracts if needed

## Incident response

1. `pause()` on wBLOZ and BlozBridge via admin key
2. Stop relayer service
3. Post status in community channels
4. Investigate DB + wallet txs; resume only when reserves and logic are confirmed
