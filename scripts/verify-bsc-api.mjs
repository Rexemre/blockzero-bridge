import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const apiKey = process.env.BSCSCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY;
if (!apiKey) {
  console.error("Set BSCSCAN_API_KEY or ETHERSCAN_API_KEY in .env");
  process.exit(1);
}

const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments.json"), "utf8"));
const buildDir = path.join(root, "artifacts", "build-info");
const buildFile = fs.readdirSync(buildDir).map((f) => path.join(buildDir, f))[0];
const bi = JSON.parse(fs.readFileSync(buildFile, "utf8"));

const admin = dep.deployer.toLowerCase().replace("0x", "").padStart(64, "0");
const wbloz = dep.wBLOZ.toLowerCase().replace("0x", "").padStart(64, "0");

const jobs = [
  ["WBLOZ", dep.wBLOZ, "contracts/WBLOZ.sol:WBLOZ", admin],
  ["BlozBridge", dep.bridge, "contracts/BlozBridge.sol:BlozBridge", wbloz + admin],
  ["BlozWrapClaim", dep.wrapClaim, "contracts/BlozWrapClaim.sol:BlozWrapClaim", wbloz + admin],
].filter(([, addr]) => addr);

async function submit([name, addr, contractname, args]) {
  const params = new URLSearchParams({
    apikey: apiKey,
    module: "contract",
    action: "verifysourcecode",
    contractaddress: addr,
    sourceCode: JSON.stringify(bi.input),
    codeformat: "solidity-standard-json-input",
    contractname,
    compilerversion: "v" + bi.solcLongVersion,
    constructorArguements: args,
  });
  const r = await fetch("https://api.etherscan.io/v2/api?chainid=56", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const j = await r.json();
  const msg = String(j.result ?? j.message ?? "");
  if (/already verified/i.test(msg)) {
    console.log(name, "already verified");
    return null;
  }
  console.log(name, j.message, j.result ?? j);
  return j.result;
}

async function poll(guid, name) {
  for (let i = 0; i < 12; i++) {
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
    console.log(`  ${name}:`, status);
    if (/pass|fail|verified/i.test(String(status))) return status;
  }
}

for (const job of jobs) {
  const guid = await submit(job);
  if (guid) await poll(guid, job[0]);
}
