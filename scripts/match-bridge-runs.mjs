import { execSync } from "child_process";
import fs from "fs";

async function chainBody() {
  const r = await fetch("https://bsc-dataseed.binance.org/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getCode",
      params: ["0xA7f3bEe62b20F041358062d890eF60b4E12464b7", "latest"],
    }),
  });
  const hex = (await r.json()).result;
  const b = Buffer.from(hex.slice(2), "hex");
  const ml = b.readUInt16BE(b.length - 2);
  return b.slice(0, b.length - 2 - ml);
}

function localBody() {
  const art = JSON.parse(
    fs.readFileSync("artifacts/contracts/BlozBridge.sol/BlozBridge.json", "utf8")
  );
  const b = Buffer.from(art.deployedBytecode.slice(2), "hex");
  const ml = b.readUInt16BE(b.length - 2);
  return b.slice(0, b.length - 2 - ml);
}

const chain = await chainBody();
execSync("npm install @openzeppelin/contracts@5.3.0 --no-save --silent", { stdio: "pipe" });

for (const evm of ["cancun", "paris", "shanghai"]) {
  for (const runs of Array.from({ length: 200 }, (_, i) => i + 1)) {
    for (const viaIR of [true, false]) {
      const cfg = `import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
const config: HardhatUserConfig = {
  solidity: { version: "0.8.28", settings: { optimizer: { enabled: true, runs: ${runs} }, evmVersion: "${evm}", viaIR: ${viaIR} } },
  networks: { hardhat: {} }
};
export default config;
`;
      fs.writeFileSync("hardhat.config.ts", cfg);
      try {
        execSync("npx hardhat compile --force", { stdio: "pipe" });
        const local = localBody();
        if (local.equals(chain)) {
          console.log(`EXACT MATCH evm=${evm} runs=${runs} viaIR=${viaIR}`);
          process.exit(0);
        }
        if (local.length === chain.length) {
          console.log(`SAME LEN ${local.length} evm=${evm} runs=${runs} viaIR=${viaIR}`);
        }
      } catch {
        /* skip */
      }
    }
  }
}
console.log("no exact match, chain len", chain.length);
