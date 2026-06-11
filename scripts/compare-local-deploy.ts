import { ethers } from "hardhat";

async function main() {
  const wBLOZ = "0x395B11E87ac0630aF9DC32520f411dB17C13F24C";
  const admin = "0x05099631D705210ab9B62fd696111A27446e1117";
  const bridgeAddr = "0xA7f3bEe62b20F041358062d890eF60b4E12464b7";

  const Factory = await ethers.getContractFactory("BlozBridge");
  const deployed = await Factory.deploy(wBLOZ, admin);
  await deployed.waitForDeployment();
  const local = await ethers.provider.getCode(await deployed.getAddress());

  const rpc = "https://bsc-dataseed.binance.org/";
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getCode",
      params: [bridgeAddr, "latest"],
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
  console.log("local deploy body", lb.length);
  console.log("chain body", cb.length);
  console.log("exact match", lb.equals(cb));

  if (!lb.equals(cb)) {
    const diffs: number[] = [];
    for (let i = 0; i < Math.max(lb.length, cb.length); i++) {
      if (lb[i] !== cb[i]) diffs.push(i);
    }
    console.log("diff bytes", diffs.length);
    if (diffs.length > 0) {
      const i = diffs[0];
      console.log("first diff at", i, "local", lb[i], "chain", cb[i]);
      const j = diffs[diffs.length - 1];
      console.log("last diff at", j, "local", lb[j], "chain", cb[j]);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
