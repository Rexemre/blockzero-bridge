import { run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const depPath = path.join(__dirname, "..", "deployments.json");
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8")) as {
    wBLOZ: string;
    bridge: string;
    wrapClaim?: string;
    deployer?: string;
    operator?: string;
  };
  const admin = dep.deployer;
  const operator = dep.operator ?? admin;

  for (const [name, address, args] of [
    ["WBLOZ", dep.wBLOZ, [admin]],
    ["BlozBridge", dep.bridge, [dep.wBLOZ, admin]],
    ...(dep.wrapClaim
      ? [["BlozWrapClaim", dep.wrapClaim, [dep.wBLOZ, operator]] as const]
      : []),
  ] as const) {
    console.log(`Sourcify verify ${name} @ ${address}…`);
    try {
      await run("verify:verify", {
        address,
        constructorArguments: args,
      });
      console.log(`  OK ${name}`);
    } catch (err) {
      console.error(`  FAIL ${name}:`, err instanceof Error ? err.message : err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
