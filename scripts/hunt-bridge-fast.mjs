import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const bridgeAddr = "0xA7f3bEe62b20F041358062d890eF60b4E12464b7";
const huntDir = path.join(root, ".bridge-hunt-fast");

const CURRENT_UNWRAP = `        require(_startsWithBz1(bz1Address), "must start with bz1");`;
const OLD_UNWRAP = `        require(
            keccak256(bytes(bz1Address)) == keccak256(bytes("bz1")) ||
                _startsWithBz1(bz1Address),
            "must start with bz1"
        );`;

function stripBody(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (b.length < 2) return b;
  const ml = b.readUInt16BE(b.length - 2);
  return b.slice(0, b.length - 2 - ml);
}

async function fetchChainBody() {
  const res = await fetch("https://bsc-dataseed.binance.org/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getCode",
      params: [bridgeAddr, "latest"],
    }),
  });
  return stripBody((await res.json()).result);
}

function makeSource(variant) {
  const base = fs.readFileSync(path.join(root, "contracts", "BlozBridge.sol"), "utf8");
  return variant === "old" ? base.replace(CURRENT_UNWRAP, OLD_UNWRAP) : base;
}

function ensureHuntDir() {
  if (fs.existsSync(huntDir)) fs.rmSync(huntDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(huntDir, "contracts"), { recursive: true });
  fs.copyFileSync(path.join(root, "contracts", "WBLOZ.sol"), path.join(huntDir, "contracts", "WBLOZ.sol"));
  fs.writeFileSync(
    path.join(huntDir, "package.json"),
    JSON.stringify(
      {
        devDependencies: {
          "@nomicfoundation/hardhat-toolbox": "^5.0.0",
          "@openzeppelin/contracts": "5.3.0",
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
    path.join(huntDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "commonjs", strict: true } })
  );
  try {
    fs.symlinkSync(path.join(root, "node_modules"), path.join(huntDir, "node_modules"), "junction");
  } catch {
    execSync("npm install --silent", { cwd: huntDir, stdio: "pipe" });
  }
}

function compile(variant, { evmVersion, runs, viaIR }) {
  fs.writeFileSync(path.join(huntDir, "contracts", "BlozBridge.sol"), makeSource(variant));
  const evm = evmVersion ? `, evmVersion: "${evmVersion}"` : "";
  const via = viaIR ? ", viaIR: true" : "";
  fs.writeFileSync(
    path.join(huntDir, "hardhat.config.ts"),
    `import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
const config: HardhatUserConfig = {
  solidity: { version: "0.8.28", settings: { optimizer: { enabled: true, runs: ${runs} }${evm}${via} } },
  paths: { sources: "./contracts", cache: "./cache", artifacts: "./artifacts" },
};
export default config;
`
  );
  execSync("npx hardhat compile --force", { cwd: huntDir, stdio: "pipe" });
  const art = JSON.parse(
    fs.readFileSync(path.join(huntDir, "artifacts", "contracts", "BlozBridge.sol", "BlozBridge.json"), "utf8")
  );
  const buildInfoDir = path.join(huntDir, "artifacts", "build-info");
  const buildInfo = path.join(buildInfoDir, fs.readdirSync(buildInfoDir)[0]);
  return { body: stripBody(art.deployedBytecode), buildInfo };
}

async function main() {
  ensureHuntDir();
  const chain = await fetchChainBody();
  console.log("chain body", chain.length);

  const evms = [undefined, "paris", "cancun", "shanghai"];
  const runsList = [200, 1000, 100, 500, 800];
  const variants = ["current", "old"];

  for (const variant of variants) {
    for (const evm of evms) {
      for (const runs of runsList) {
        for (const viaIR of [false, true]) {
          try {
            const { body, buildInfo } = compile(variant, { evmVersion: evm, runs, viaIR });
            const delta = body.length - chain.length;
            if (body.equals(chain)) {
              console.log("EXACT", { variant, evm: evm ?? "default", runs, viaIR, bytes: body.length });
              const bi = JSON.parse(fs.readFileSync(buildInfo, "utf8"));
              fs.writeFileSync(
                path.join(root, "scripts", "bridge-verify-match.json"),
                JSON.stringify(
                  {
                    variant,
                    evm: evm ?? "default",
                    runs,
                    viaIR,
                    buildInfo,
                    solcLongVersion: bi.solcLongVersion,
                    constructorArgs:
                      "000000000000000000000000395b11e87ac0630af9dc32520f411db17c13f24c" +
                      "00000000000000000000000005099631d705210ab9b62fd696111a27446e1117",
                  },
                  null,
                  2
                )
              );
              return;
            }
            if (Math.abs(delta) <= 2) {
              console.log("CLOSE", { variant, evm: evm ?? "default", runs, viaIR, bytes: body.length, delta });
            }
          } catch (e) {
            // ignore
          }
        }
      }
    }
  }
  console.log("NO EXACT MATCH");
  process.exit(1);
}

main();
