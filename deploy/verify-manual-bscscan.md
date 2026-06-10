# Manual BscScan verify (when Hardhat bytecode mismatch)

Hardhat auto-verify failed because deployed bytecode differs slightly from current local compile
(deploy machine used different solc codegen). **wBLOZ address stays the same** — manual verify is fine.

## Per contract (repeat 3×)

Open BscScan → contract address → **Verify & Publish** → **Solidity (Single file)** or **Standard JSON**

### WBLOZ `0x395B11E87ac0630aF9DC32520f411dB17C13F24C`

- Compiler: **0.8.28**
- Optimization: **Yes**, **200** runs
- EVM: **cancun**
- Constructor args (ABI-encoded address):  
  `00000000000000000000000005099631d705210ab9b62fd696111a27446e1117`
- Upload: flatten `contracts/WBLOZ.sol` + OpenZeppelin imports, or use `artifacts/build-info/*.json` Standard JSON Input

### BlozBridge `0xA7f3bEe62b20F041358062d890eF60b4E12464b7`

Constructor: `(address wBLOZ, address admin)`  
`0x395B11E87ac0630aF9DC32520f411dB17C13F24C`, `0x05099631D705210ab9B62fd696111A27446e1117`

### BlozWrapClaim `0x03cE8aA17Fa59E62Fd7E5af327f8b4AE47091727`

Constructor: `(address wBLOZ, address signer)`  
`0x395B11E87ac0630aF9DC32520f411dB17C13F24C`, `0x05099631D705210ab9B62fd696111A27446e1117`

## Standard JSON (easiest)

1. `npx hardhat compile --force`
2. Upload `artifacts/build-info/466b7a459572b730d37f9b4407fa8bc9.json` → field **standard-json-input**
3. Pick contract name from dropdown
4. Paste constructor args as above

## API note

Etherscan.io API keys work on https://bscscan.com/verifyContract but the **REST API v2 free tier does not include BSC**.
Browser verification on bscscan.com still works.
