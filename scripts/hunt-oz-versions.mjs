import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const hunt = path.join(root, ".bridge-hunt-oz");
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

function stripBody(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  const ml = b.readUInt16BE(b.length - 2);
  return b.slice(0, b.length - 2 - ml);
}

async function chainData() {
  const rpc = "https://bsc-dataseed.binance.org/";
  const tx = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionByHash",
      params: [BRIDGE_TX],
    }),
  });
  const creation = (await tx.json()).result.input.replace(/^0x/, "").toLowerCase();
  const code = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getCode",
      params: ["0xA7f3bEe62b20F041358062d890eF60b4E12464b7", "latest"],
    }),
  });
  const runtime = stripBody((await code.json()).result);
  return { creation, runtime };
}

function setup(oz) {
  if (fs.existsSync(hunt)) fs.rmSync(hunt, { recursive: true, force: true });
  fs.mkdirSync(path.join(hunt, "contracts"), { recursive: true });
  fs.copyFileSync(path.join(root, "contracts", "WBLOZ.sol"), path.join(hunt, "contracts", "WBLOZ.sol"));
  fs.writeFileSync(
    path.join(hunt, "package.json"),
    JSON.stringify(
      {
        devDependencies: {
          "@nomicfoundation/hardhat-toolbox": "^5.0.0",
          "@openzeppelin/contracts": oz,
          hardhat: "^2.22.19",
          typescript: "^5.8.2",
          "ts-node": "^10.9.2",
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(hunt, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "commonjs", strict: true } })
  );
  execSync("npm install --silent", { cwd: hunt, stdio: "pipe" });
}

function compile(variant, oz, settings) {
  setup(oz);
  let src = fs.readFileSync(path.join(root, "contracts", "BlozBridge.sol"), "utf8");
  if (variant === "old") src = src.replace(CURRENT, OLD);
  fs.writeFileSync(path.join(hunt, "contracts", "BlozBridge.sol"), src);
  const evm = settings.evmVersion ? `, evmVersion: "${settings.evmVersion}"` : "";
  const via = settings.viaIR ? ", viaIR: true" : "";
  const runs = settings.runs ?? 200;
  fs.writeFileSync(
    path.join(hunt, "hardhat.config.ts"),
    `import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
const config: HardhatUserConfig = {
  solidity: { version: "0.8.28", settings: { optimizer: { enabled: true, runs: ${runs} }${evm}${via} } },
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
  const creation = (art.bytecode + CONSTRUCTOR).replace(/^0x/, "").toLowerCase();
  const runtime = stripBody(art.deployedBytecode);
  return { creation, runtime, biFile };
}

const { creation: chainCreation, runtime: chainRuntime } = await chainData();
console.log("chain creation", chainCreation.length / 2, "runtime", chainRuntime.length);

const ozList = ["5.6.1", "5.3.0", "5.5.0", "5.4.0", "5.2.0", "5.0.2"];
for (const oz of ozList) {
  for (const variant of ["old", "current"]) {
    for (const evm of [undefined, "paris", "cancun"]) {
      try {
        const { creation, runtime, biFile } = compile(variant, oz, { evmVersion: evm });
        const cExact = creation === chainCreation;
        const rExact = runtime.equals(chainRuntime);
        if (cExact || rExact) {
          console.log("MATCH", { oz, variant, evm: evm ?? "default", cExact, rExact, biFile });
          if (cExact && rExact) {
            fs.writeFileSync(
              path.join(root, "scripts", "bridge-verify-match.json"),
              JSON.stringify({ oz, variant, evm: evm ?? "default", buildInfo: biFile }, null, 2)
            );
            process.exit(0);
          }
        }
        const cd = creation.length - chainCreation.length;
        const rd = runtime.length - chainRuntime.length;
        if (Math.abs(cd) <= 4 || Math.abs(rd) <= 4) {
          console.log("CLOSE", { oz, variant, evm: evm ?? "default", cd, rd });
        }
      } catch (e) {
        console.log("fail", oz, variant, evm, e.message?.slice(0, 60));
      }
    }
  }
}
console.log("no exact match");
process.exit(1);
