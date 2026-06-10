import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const depPath = path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(depPath)) {
    throw new Error("Missing deployments.json — run deploy:bsc first");
  }
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8")) as {
    wBLOZ: string;
    operator?: string;
    wrapClaim?: string;
  };

  const [deployer] = await ethers.getSigners();
  const operator = process.env.BSC_OPERATOR_ADDRESS ?? dep.operator ?? deployer.address;
  const wBLOZAddress = process.env.WBLOZ_ADDRESS ?? dep.wBLOZ;

  console.log("Deployer:", deployer.address);
  console.log("Claim signer:", operator);
  console.log("wBLOZ:", wBLOZAddress);

  const BlozWrapClaim = await ethers.getContractFactory("BlozWrapClaim");
  const claim = await BlozWrapClaim.deploy(wBLOZAddress, operator);
  await claim.waitForDeployment();
  const claimAddress = await claim.getAddress();
  console.log("BlozWrapClaim:", claimAddress);

  const wBLOZ = await ethers.getContractAt("WBLOZ", wBLOZAddress);
  const minterRole = await wBLOZ.MINTER_ROLE();
  const txGrant = await wBLOZ.grantRole(minterRole, claimAddress);
  await txGrant.wait();
  console.log("Granted MINTER_ROLE to BlozWrapClaim");

  if (operator.toLowerCase() !== claimAddress.toLowerCase()) {
    const hasMinter = await wBLOZ.hasRole(minterRole, operator);
    if (hasMinter) {
      const txRevoke = await wBLOZ.revokeRole(minterRole, operator);
      await txRevoke.wait();
      console.log("Revoked MINTER_ROLE from operator EOA (relayer signs only now)");
    }
  }

  const out = {
    ...dep,
    wrapClaim: claimAddress,
    claimDeployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(depPath, JSON.stringify(out, null, 2));
  console.log("Updated", depPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
