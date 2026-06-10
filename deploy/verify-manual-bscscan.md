# BscScan contract verification

## Status (2026-06-10)

| Contract | Address | BscScan |
|----------|---------|---------|
| **WBLOZ** | `0x395B11E87ac0630aF9DC32520f411dB17C13F24C` | Verified (Exact Match) |
| **BlozWrapClaim** | `0x03cE8aA17Fa59E62Fd7E5af327f8b4AE47091727` | Verified (Exact Match) |
| **BlozBridge** | `0xA7f3bEe62b20F041358062d890eF60b4E12464b7` | Verified (Exact Match) |

## Compiler settings that worked

### WBLOZ (verified)

- solc **0.8.28**
- OpenZeppelin **5.3.0**
- Optimizer **200** runs
- EVM **paris** (not cancun)
- Constructor: `0x05099631D705210ab9B62fd696111A27446e1117`

### BlozWrapClaim (verified)

- solc **0.8.28**
- Optimizer **200** runs
- EVM **cancun**
- Constructor: wBLOZ + `0x05099631D705210ab9B62fd696111A27446e1117`

### BlozBridge (verified)

- solc **0.8.28**
- OpenZeppelin **5.6.1** (resolved from `package-lock.json` at deploy time, not `^5.3.0` in `package.json`)
- Optimizer **200** runs
- EVM **paris** (Hardhat default; no explicit `evmVersion` in config at deploy)
- Source: current `BlozBridge.sol` (`_startsWithBz1` check only)
- Constructor: wBLOZ + `0x05099631D705210ab9B62fd696111A27446e1117`

Reproduce and verify without redeploy:

```bash
node scripts/verify-bridge-match.mjs
```

Match metadata: `scripts/bridge-verify-match.json`

## API verify (works on BSC via Etherscan v2)

Use `bi.input` from `artifacts/build-info/*.json`, **not** the wrapper file:

```bash
npm install
npx hardhat compile --force
node scripts/verify-bsc-api.mjs
```

Requires `BSCSCAN_API_KEY` or `ETHERSCAN_API_KEY` in `.env`.

## Manual UI

BscScan → contract → **Verify & Publish** → **Standard JSON Input** → upload `artifacts/build-info/<hash>.json` content field `input` only, or full file with format **solidity-standard-json-input**.

Constructor args (ABI-encoded, no `0x` prefix):

- WBLOZ: `00000000000000000000000005099631d705210ab9b62fd696111a27446e1117`
- Bridge: `000000000000000000000000395b11e87ac0630af9dc32520f411db17c13f24c` + admin (above)
- Claim: same as Bridge constructor layout
