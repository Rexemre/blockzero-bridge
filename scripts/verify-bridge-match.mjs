import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
dotenv.config({ path: path.join(root, ".env") });

const MATCH = {
  oz: "5.6.1",
  variant: "current",
  evm: "default",
  runs: 200,
};

const BRIDGE = "0xA7f3bEe62b20F041358062d890eF60b4E12464b7";
const BRIDGE_TX = "0x3cfd2257cfdf0aec46a95273a82a32aa3c9b1f851dedf03206979e3d644777ae";
const CONSTRUCTOR =
  "000000000000000000000000395b11e87ac0630af9dc32520f411db17c13f24c" +
  "00000000000000000000000005099631d705210ab9b62fd696111a27446e1117";

const hunt = path.join(root, ".bridge-verify-build");
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

async function chainCreation() {
  const r = await fetch("https://bsc-dataseed.binance.org/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionByHash",
      params: [BRIDGE_TX],
    }),
  });
  return (await r.json()).result.input.replace(/^0x/, "").toLowerCase();
}

function build() {
  if (fs.existsSync(hunt)) fs.rmSync(hunt, { recursive: true, force: true });
  fs.mkdirSync(path.join(hunt, "contracts"), { recursive: true });
  fs.copyFileSync(path.join(root, "contracts", "WBLOZ.sol"), path.join(hunt, "contracts", "WBLOZ.sol"));
  let src = fs.readFileSync(path.join(root, "contracts", "BlozBridge.sol"), "utf8");
  if (MATCH.variant === "old") src = src.replace(CURRENT, OLD);
  fs.writeFileSync(path.join(hunt, "contracts", "BlozBridge.sol"), src);
  fs.writeFileSync(
    path.join(hunt, "package.json"),
    JSON.stringify(
      {
        devDependencies: {
          "@nomicfoundation/hardhat-toolbox": "^5.0.0",
          "@openzeppelin/contracts": MATCH.oz,
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
  const evm = MATCH.evm !== "default" ? `, evmVersion: "${MATCH.evm}"` : "";
  fs.writeFileSync(
    path.join(hunt, "hardhat.config.ts"),
    `import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
const config: HardhatUserConfig = {
  solidity: { version: "0.8.28", settings: { optimizer: { enabled: true, runs: ${MATCH.runs} }${evm} } },
  paths: { sources: "./contracts", cache: "./cache", artifacts: "./artifacts" },
};
export default config;
`
  );
  execSync("npm install --silent", { cwd: hunt, stdio: "inherit" });
  execSync("npx hardhat compile --force", { cwd: hunt, stdio: "inherit" });
  const art = JSON.parse(
    fs.readFileSync(path.join(hunt, "artifacts", "contracts", "BlozBridge.sol", "BlozBridge.json"), "utf8")
  );
  const biDir = path.join(hunt, "artifacts", "build-info");
  const biFile = path.join(biDir, fs.readdirSync(biDir)[0]);
  const bi = JSON.parse(fs.readFileSync(biFile, "utf8"));
  const creation = (art.bytecode + CONSTRUCTOR).replace(/^0x/, "").toLowerCase();
  return { bi, biFile, creation };
}

async function verify(bi) {
  const apiKey = process.env.BSCSCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY;
  if (!apiKey) throw new Error("Set BSCSCAN_API_KEY in .env");

  const params = new URLSearchParams({
    apikey: apiKey,
    module: "contract",
    action: "verifysourcecode",
    contractaddress: BRIDGE,
    sourceCode: JSON.stringify(bi.input),
    codeformat: "solidity-standard-json-input",
    contractname: "contracts/BlozBridge.sol:BlozBridge",
    compilerversion: "v" + bi.solcLongVersion,
    constructorArguements: CONSTRUCTOR,
  });
  const r = await fetch("https://api.etherscan.io/v2/api?chainid=56", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const j = await r.json();
  const msg = String(j.result ?? j.message ?? "");
  if (/already verified/i.test(msg)) {
    console.log("BlozBridge already verified");
    return null;
  }
  console.log("submit:", j.message, j.result ?? j);
  return j.result;
}

async function poll(guid) {
  const apiKey = process.env.BSCSCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 8000));
    const params = new URLSearchParams({
      apikey: apiKey,
      module: "contract",
      action: "checkverifystatus",
      guid,
    });
    const r = await fetch("https://api.etherscan.io/v2/api?chainid=56", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const j = await r.json();
    const status = j.result ?? j.message;
    console.log("status:", status);
    if (/pass|fail|verified/i.test(String(status))) return status;
  }
}

const chain = await chainCreation();
const { bi, biFile, creation } = build();
const ok = creation === chain;
console.log("creation match:", ok, "local", creation.length / 2, "chain", chain.length / 2);
if (!ok) {
  console.error("Bytecode mismatch — aborting verify");
  process.exit(1);
}

const out = path.join(root, "scripts", "bridge-verify-match.json");
fs.writeFileSync(out, JSON.stringify({ ...MATCH, buildInfo: biFile }, null, 2));
console.log("saved", out);

const guid = await verify(bi);
if (guid) await poll(guid);
