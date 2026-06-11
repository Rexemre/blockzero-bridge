import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const bridgeAddr = "0xA7f3bEe62b20F041358062d890eF60b4E12464b7";

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
  const j = await res.json();
  return stripBody(j.result);
}

function readBridgeArtifact(artifactPath) {
  const art = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return stripBody(art.deployedBytecode);
}

function makeBridgeSource(variant) {
  const base = fs.readFileSync(path.join(root, "contracts", "BlozBridge.sol"), "utf8");
  if (variant === "current") return base;
  return base.replace(CURRENT_UNWRAP, OLD_UNWRAP);
}

function writeHuntConfig(dir, { evmVersion, runs, viaIR, ozPath }) {
  const evmLine = evmVersion ? `, evmVersion: "${evmVersion}"` : "";
  const viaLine = viaIR ? ", viaIR: true" : "";
  const remaps = ozPath
    ? `
    remappings: [
      "@openzeppelin/contracts/=${path.relative(dir, ozPath).replace(/\\/g, "/")}/",
    ],`
    : "";
  const cfg = `import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: ${runs} }${evmLine}${viaLine},
    },
  },${remaps}
  paths: {
    sources: "./contracts",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
export default config;
`;
  fs.writeFileSync(path.join(dir, "hardhat.config.ts"), cfg);
}

function compileIn(dir) {
  execSync("npx hardhat compile --force", {
    cwd: dir,
    stdio: "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
}

function setupHuntDir(dir, variant, wblozSrc) {
  fs.mkdirSync(path.join(dir, "contracts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "contracts", "BlozBridge.sol"), makeBridgeSource(variant));
  fs.copyFileSync(wblozSrc, path.join(dir, "contracts", "WBLOZ.sol"));
  const pkg = {
    name: "hunt",
    private: true,
    devDependencies: {
      "@nomicfoundation/hardhat-toolbox": "^5.0.0",
      "@openzeppelin/contracts": "5.3.0",
      hardhat: "^2.22.19",
      typescript: "^5.8.2",
      "ts-node": "^10.9.2",
    },
  };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "commonjs", strict: true } })
  );
  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    execSync("npm install --silent", { cwd: dir, stdio: "pipe" });
  }
}

const ozVersions = ["5.3.0", "5.2.0", "5.1.0", "5.0.2", "5.4.0", "5.5.0"];
const evmVersions = [undefined, "paris", "cancun", "shanghai", "london"];
const runsList = [200, 1000, 100, 500];
const viaIRs = [false, true];
const variants = ["current", "old"];

async function main() {
  const chainBody = await fetchChainBody();
  console.log("chain runtime body bytes:", chainBody.length);
  const wblozSrc = path.join(root, "contracts", "WBLOZ.sol");
  const huntRoot = path.join(root, ".bridge-hunt");
  if (fs.existsSync(huntRoot)) fs.rmSync(huntRoot, { recursive: true, force: true });
  fs.mkdirSync(huntRoot, { recursive: true });

  const matches = [];
  let tested = 0;

  for (const variant of variants) {
    for (const oz of ozVersions) {
      const ozPath = path.join(root, "node_modules", "@openzeppelin", "contracts");
      // only use alternate OZ if installed in hunt dir
      const dir = path.join(huntRoot, `${variant}-oz${oz.replace(/\./g, "")}`);
      setupHuntDir(dir, variant, wblozSrc);
      if (oz !== "5.3.0") {
        execSync(`npm install --silent @openzeppelin/contracts@${oz}`, { cwd: dir, stdio: "pipe" });
      }

      for (const evm of evmVersions) {
        for (const runs of runsList) {
          for (const viaIR of viaIRs) {
            tested++;
            try {
              writeHuntConfig(dir, { evmVersion: evm, runs, viaIR, ozPath: null });
              compileIn(dir);
              const artPath = path.join(dir, "artifacts", "contracts", "BlozBridge.sol", "BlozBridge.json");
              const localBody = readBridgeArtifact(artPath);
              const exact = localBody.equals(chainBody);
              const sizeDelta = localBody.length - chainBody.length;
              if (exact || Math.abs(sizeDelta) <= 4) {
                const label = `${variant} oz=${oz} evm=${evm ?? "default"} runs=${runs} viaIR=${viaIR} bytes=${localBody.length} delta=${sizeDelta}`;
                console.log(exact ? "EXACT MATCH:" : "CLOSE:", label);
                if (exact) {
                  matches.push({
                    variant,
                    oz,
                    evm: evm ?? "default",
                    runs,
                    viaIR,
                    dir,
                    buildInfo: fs
                      .readdirSync(path.join(dir, "artifacts", "build-info"))
                      .map((f) => path.join(dir, "artifacts", "build-info", f))[0],
                  });
                }
              }
            } catch {
              // skip invalid combos
            }
          }
        }
      }
    }
  }

  console.log("tested", tested, "combinations");
  if (matches.length === 0) {
    console.log("NO EXACT MATCH");
    process.exit(1);
  }

  const best = matches[0];
  const out = {
    ...best,
    bridge: bridgeAddr,
    constructorArgs:
      "000000000000000000000000395b11e87ac0630af9dc32520f411db17c13f24c" +
      "00000000000000000000000005099631d705210ab9b62fd696111a27446e1117",
  };
  fs.writeFileSync(path.join(root, "scripts", "bridge-verify-match.json"), JSON.stringify(out, null, 2));
  console.log("saved scripts/bridge-verify-match.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
