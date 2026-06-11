import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const hunt = path.join(root, ".bridge-hunt-fast");
const bridgeAddr = "0xA7f3bEe62b20F041358062d890eF60b4E12464b7";

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

async function chainBody() {
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
  return { body: stripBody(art.deployedBytecode), creation: art.bytecode, biFile };
}

function diffCount(a, b) {
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
}

async function main() {
  const chain = await chainBody();
  console.log("chain body bytes:", chain.length);

  const combos = [];
  for (const variant of ["old", "current"]) {
    for (const evm of [undefined, "paris", "cancun", "shanghai", "london"]) {
      for (const runs of [200, 1000, 100, 500]) {
        for (const viaIR of [false, true]) {
          for (const bytecodeHash of [undefined, "ipfs", "none", "bzzr1"]) {
            for (const solc of ["0.8.28", "0.8.27", "0.8.26"]) {
              combos.push({ variant, evmVersion: evm, runs, viaIR, bytecodeHash, solc });
            }
          }
        }
      }
    }
  }

  let best = null;
  for (const c of combos) {
    try {
      const { body, biFile } = compile(c.variant, c);
      const exact = body.equals(chain);
      const delta = body.length - chain.length;
      const diffs = diffCount(body, chain);
      if (exact) {
        console.log("EXACT MATCH", c, biFile);
        fs.writeFileSync(
          path.join(root, "scripts", "bridge-verify-match.json"),
          JSON.stringify({ ...c, buildInfo: biFile, exact: true }, null, 2)
        );
        return;
      }
      if (!best || diffs < best.diffs || (diffs === best.diffs && Math.abs(delta) < Math.abs(best.delta))) {
        best = { ...c, bytes: body.length, delta, diffs, biFile };
      }
      if (Math.abs(delta) <= 4) {
        console.log("CLOSE", c, "bytes", body.length, "delta", delta, "diffs", diffs);
      }
    } catch {
      // skip
    }
  }
  console.log("best", best);
  if (best) {
    fs.writeFileSync(path.join(root, "scripts", "bridge-verify-match.json"), JSON.stringify(best, null, 2));
  }
  process.exit(1);
}

main();
