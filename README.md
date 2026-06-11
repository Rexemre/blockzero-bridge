# Block Zero Bridge — BLOZ ↔ wBLOZ (BSC)



Wrap native **BLOZ** (Block Zero mainnet) to **wBLOZ** (BEP-20 on BNB Smart Chain) for DEX liquidity.  

8 decimals. **3.9% bridge fee** per wrap and unwrap (`BRIDGE_FEE_BPS=390`). Unwrap burns wBLOZ and sends native BLOZ back. The fee stays in the BLOZ reserve, so wBLOZ remains over-backed.



**Live UI:** https://bridge.bloz.org  

**User guide:** [bridge-guide.md](https://github.com/Rexemre/blockzero-docs/blob/main/bridge-guide.md)  

**Security:** [SECURITY.md](./SECURITY.md)

## Official links

| | |
|---|---|
| **Website** | https://bloz.org |
| **Pool** | https://pool.bloz.org *(test release)* |
| **Explorer** | https://explorer.bloz.org · testnet: https://texplorer.bloz.org |
| **Bridge** | https://bridge.bloz.org |
| **Discord** | https://discord.gg/FbJzrwAU2W |
| **X (Twitter)** | https://x.com/BlockZeroBLOZ |
| **Full list** | [official-links.md](https://github.com/Rexemre/blockzero-docs/blob/main/official-links.md) |

## Architecture



| Component | Role |

|-----------|------|

| `contracts/WBLOZ.sol` | ERC-20 on BSC; minted only via `BlozWrapClaim` |

| `contracts/BlozBridge.sol` | Users burn wBLOZ here → relayer pays native BLOZ |

| `contracts/BlozWrapClaim.sol` | Users claim wBLOZ with relayer EIP-712 signature |

| `relayer/` | Watches deposits, signs claims, unwraps, auto-refunds |

| `web/` | `bridge.bloz.org` UI (MetaMask) |



## Transparency



- Live reserves: `GET /api/status` or the bridge homepage

- Contracts are **verified on BscScan** — re-verify after deploy: `npm run verify:bsc` or `npm run verify:bridge` for BlozBridge (needs `BSCSCAN_API_KEY`)

- Deployed addresses: `deployments.json`



## Auto-refund



BLOZ is automatically returned to the **original sending `bz1…` address** (minus network fee) when:



- Deposit is below minimum

- Duplicate deposit to the same address

- Deposit to an expired / unknown address

- wBLOZ not claimed within `CLAIM_EXPIRY_HOURS` (default 7 days)



Refund fee: only the network fee `UNWRAP_NETWORK_FEE_BLOZ` (default `0.00001` BLOZ) — **no 3.9% bridge fee** on refunds.



## Quick start



### 1. Deploy contracts on BSC



```bash

cp .env.example .env

# Set BSC_DEPLOYER_PRIVATE_KEY, BSC_OPERATOR_ADDRESS (relayer hot wallet)



npm install

npm run compile

npm run deploy:bsc

npm run deploy:claim

# Writes deployments.json with wBLOZ + bridge + wrapClaim addresses

```



```bash

# After deploy — verify source on BscScan

BSCSCAN_API_KEY=... npm run verify:bsc

```



Grant **MINTER_ROLE** on wBLOZ to `BlozWrapClaim` (done by `deploy:claim`).



Fund the operator wallet with **BNB** for gas (users pay BNB on claim; operator only signs).



### 2. Configure relayer (VPS with bitcoind)



```bash

cd relayer && npm install && npm run build

```



`.env` (see `.env.example`):



- `BLOZ_DATADIR` — mainnet datadir (same node as seed or dedicated)

- `BLOZ_BRIDGE_WALLET=bridge` — dedicated wallet; fund with BLOZ for unwrap payouts

- `WBLOZ_ADDRESS`, `BRIDGE_ADDRESS`, `WRAP_CLAIM_ADDRESS` — from `deployments.json`

- `BSC_OPERATOR_PRIVATE_KEY` — claim signer (no direct mint role after deploy:claim)

- `CLAIM_EXPIRY_HOURS=168` — auto-refund unclaimed wraps after 7 days



```bash

npm run relayer

# Listens on :3010, serves web/ + API

```



Create bridge wallet once (automatic on first start):



```bash

bitcoin-cli -datadir=$BLOZ_DATADIR createwallet bridge

# Send initial BLOZ reserve for unwrap liquidity

```



### 3. DNS + Caddy



Add **A record**: `bridge.bloz.org → 217.160.46.61`



```bash

ln -sf /opt/blockzero-bridge/deploy/Caddyfile.snippet /etc/caddy/sites/blockzero-bridge.caddy

systemctl restart caddy

```



### 4. DEX (PancakeSwap)



1. Verify wBLOZ on [BscScan](https://bscscan.com)

2. Add liquidity: wBLOZ / WBNB or wBLOZ / USDT on PancakeSwap V2

3. Publish token info (logo, decimals **8**, website bloz.org)



## Wrap flow



1. User connects MetaMask on `bridge.bloz.org`

2. Creates deposit address (unique per request)

3. Sends native BLOZ from Block Zero wallet

4. After 6 confirmations → user claims wBLOZ on BSC (BNB gas) — receives **96.1%** of the deposit (3.9% bridge fee)



## Unwrap flow



1. User approves + calls `unwrap(amount, bz1Address)` on BlozBridge

2. Relayer detects event, sends native BLOZ from bridge wallet — **96.1%** of the burned amount (3.9% bridge fee) minus the network fee



## Reserve rule



`bridge wallet BLOZ balance ≥ wBLOZ.totalSupply()` — shown live at `/api/status`.



## Security



- Custodial bridge: users trust the operator's reserves and payout/refund processing.

- Minting is contract-gated via `BlozWrapClaim` — not a manual EOA mint.

- Use a **hot wallet** for relayer; keep excess BLOZ in cold storage.

- Pause contracts via `pause()` if compromised.

- Start on **BSC testnet** (`npm run deploy:bsc-testnet`) before mainnet.



## License



MIT


