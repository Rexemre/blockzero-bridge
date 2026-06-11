import { ethers } from "hardhat";

async function main() {
  const admin = "0x05099631D705210ab9B62fd696111A27446e1117";
  const addr = "0x395B11E87ac0630aF9DC32520f411dB17C13F24C";

  const Factory = await ethers.getContractFactory("WBLOZ");
  const deployed = await Factory.deploy(admin);
  await deployed.waitForDeployment();
  const local = await ethers.provider.getCode(await deployed.getAddress());

  const res = await fetch("https://bsc-dataseed.binance.org/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getCode",
      params: [addr, "latest"],
    }),
  });
  const chain = ((await res.json()) as { result: string }).result;

  function body(hex: string) {
    const b = Buffer.from(hex.slice(2), "hex");
    const ml = b.readUInt16BE(b.length - 2);
    return b.slice(0, b.length - 2 - ml);
  }

  const lb = body(local);
  const cb = body(chain);
  console.log("WBLOZ local", lb.length, "chain", cb.length, "match", lb.equals(cb));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
