import { run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const depPath = path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(depPath)) {
    throw new Error("Missing deployments.json — deploy contracts first");
  }
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8")) as {
    wBLOZ: string;
    bridge: string;
    wrapClaim?: string;
    operator?: string;
    deployer?: string;
  };

  if (!process.env.BSCSCAN_API_KEY) {
    throw new Error("Set BSCSCAN_API_KEY in .env before verifying");
  }

  const admin = dep.deployer;
  const operator = dep.operator ?? admin;

  console.log("Verifying WBLOZ…");
  await run("verify:verify", {
    address: dep.wBLOZ,
    constructorArguments: [admin],
  });

  console.log("Verifying BlozBridge…");
  await run("verify:verify", {
    address: dep.bridge,
    constructorArguments: [dep.wBLOZ, admin],
  });

  if (dep.wrapClaim) {
    console.log("Verifying BlozWrapClaim…");
    await run("verify:verify", {
      address: dep.wrapClaim,
      constructorArguments: [dep.wBLOZ, operator],
    });
  }

  console.log("All contracts submitted to BscScan.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
