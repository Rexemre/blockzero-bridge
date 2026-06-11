import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
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

async function txInput() {
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
  return (await res.json()).result.input.toLowerCase();
}

function compile(variant, settings) {
  let src = fs.readFileSync(path.join(root, "contracts", "BlozBridge.sol"), "utf8");
  if (variant === "old") src = src.replace(CURRENT, OLD);
  fs.writeFileSync(path.join(hunt, "contracts", "BlozBridge.sol"), src);
  const evm = settings.evmVersion ? `, evmVersion: "${settings.evmVersion}"` : "";
  const via = settings.viaIR ? ", viaIR: true" : "";
  const runs = settings.runs ?? 200;
  const meta = settings.bytecodeHash
    ? `, metadata: { bytecodeHash: "${settings.bytecodeHash}" }`
    : "";
  const solc = settings.solc ?? "0.8.28";
  fs.writeFileSync(
    path.join(hunt, "hardhat.config.ts"),
    `import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
const config: HardhatUserConfig = {
  solidity: { version: "${solc}", settings: { optimizer: { enabled: true, runs: ${runs} }${evm}${via}${meta} } },
  paths: { sources: "./contracts", cache: "./cache", artifacts: "./artifacts" },
};
export default config;
`
  );
  execSync("npx hardhat compile --force", { cwd: hunt, stdio: "pipe" });
  const art = JSON.parse(
    fs.readFileSync(path.join(hunt, "artifacts", "contracts", "BlozBridge.sol", "BlozBridge.json"), "utf8")
  );
  const biDir = path.join(hunt, "artifacts", "build-info");
  const biFile = path.join(biDir, fs.readdirSync(biDir)[0]);
  const localCreation = (art.bytecode + CONSTRUCTOR).toLowerCase();
  return { localCreation, biFile, deployed: art.deployedBytecode };
}

async function main() {
  if (!fs.existsSync(path.join(hunt, "contracts"))) {
    fs.mkdirSync(path.join(hunt, "contracts"), { recursive: true });
    fs.copyFileSync(path.join(root, "contracts", "WBLOZ.sol"), path.join(hunt, "contracts", "WBLOZ.sol"));
    try {
      fs.symlinkSync(path.join(root, "node_modules"), path.join(hunt, "node_modules"), "junction");
    } catch {
      execSync("npm install --silent", { cwd: hunt, stdio: "pipe" });
    }
  }

  const chainCreation = (await txInput()).replace(/^0x/, "");
  console.log("chain creation bytes:", chainCreation.length / 2);

  const combos = [];
  for (const variant of ["old", "current"]) {
    for (const evm of [undefined, "paris", "cancun", "shanghai"]) {
      for (const runs of [200, 1000, 100, 500, 800]) {
        for (const viaIR of [false, true]) {
          combos.push({ variant, evmVersion: evm, runs, viaIR });
        }
      }
    }
  }

  for (const c of combos) {
    try {
      const { localCreation, biFile } = compile(c.variant, c);
      const local = localCreation.replace(/^0x/, "");
      const exact = local === chainCreation;
      const delta = local.length - chainCreation.length;
      if (exact || Math.abs(delta) <= 4) {
        console.log(exact ? "EXACT CREATION MATCH" : "CLOSE", c, "delta chars", delta, biFile);
        if (exact) {
          fs.writeFileSync(
            path.join(root, "scripts", "bridge-verify-match.json"),
            JSON.stringify({ ...c, buildInfo: biFile, exact: true }, null, 2)
          );
          return;
        }
      }
    } catch {
      // skip
    }
  }
  console.log("no creation match");
  process.exit(1);
}

main();
