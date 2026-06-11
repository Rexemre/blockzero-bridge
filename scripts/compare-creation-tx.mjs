import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const hunt = path.join(root, ".bridge-hunt-fast");
const BRIDGE_TX = "0x3cfd2257cfdf0aec46a95273a82a32aa3c9b1f851dedf03206979e3d644777ae";
const CONSTRUCTOR =
  "000000000000000000000000395b11e87ac0630af9dc32520f411db17c13f24c" +
  "00000000000000000000000005099631d705210ab9b62fd696111a27446e1117";

const CURRENT = `        require(_startsWithBz1(bz1Address), "must start with bz1");`;
const OLD = `        require(
            keccak256(bytes(bz1Address)) == keccak256(bytes("bz1")) ||
                _startsWithBz1(bz1Address),
            "must start with bz1"
        );`;

async function chainCreation() {
  const res = await fetch("https://bsc-dataseed.binance.org/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionByHash",
      params: [BRIDGE_TX],
    }),
  });
  return (await res.json()).result.input.replace(/^0x/, "").toLowerCase();
}

function compileOldDefault() {
  let src = fs.readFileSync(path.join(root, "contracts", "BlozBridge.sol"), "utf8");
  src = src.replace(CURRENT, OLD);
  fs.writeFileSync(path.join(hunt, "contracts", "BlozBridge.sol"), src);
  fs.writeFileSync(
    path.join(hunt, "hardhat.config.ts"),
    `import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
const config: HardhatUserConfig = {
  solidity: { version: "0.8.28", settings: { optimizer: { enabled: true, runs: 200 } } },
  paths: { sources: "./contracts", cache: "./cache", artifacts: "./artifacts" },
};
export default config;
`
  );
  execSync("npx hardhat compile --force", { cwd: hunt, stdio: "pipe" });
  const art = JSON.parse(
    fs.readFileSync(path.join(hunt, "artifacts", "contracts", "BlozBridge.sol", "BlozBridge.json"), "utf8")
  );
  return (art.bytecode + CONSTRUCTOR).replace(/^0x/, "").toLowerCase();
}

const chain = await chainCreation();
const local = compileOldDefault();
console.log("chain bytes", chain.length / 2);
console.log("local bytes", local.length / 2);
console.log("exact", chain === local);

let diffs = 0;
for (let i = 0; i < Math.min(chain.length, local.length); i += 2) {
  if (chain.slice(i, i + 2) !== local.slice(i, i + 2)) diffs++;
}
console.log("diff pairs", diffs);
console.log("chain head", chain.slice(0, 120));
console.log("local head", local.slice(0, 120));
console.log("chain tail", chain.slice(-120));
console.log("local tail", local.slice(-120));
