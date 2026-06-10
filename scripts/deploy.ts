import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const operator = process.env.BSC_OPERATOR_ADDRESS ?? deployer.address;

  console.log("Deployer:", deployer.address);
  console.log("Operator (minter):", operator);

  const WBLOZ = await ethers.getContractFactory("WBLOZ");
  const wBLOZ = await WBLOZ.deploy(deployer.address);
  await wBLOZ.waitForDeployment();
  const wBLOZAddress = await wBLOZ.getAddress();
  console.log("WBLOZ:", wBLOZAddress);

  const BlozBridge = await ethers.getContractFactory("BlozBridge");
  const bridge = await BlozBridge.deploy(wBLOZAddress, deployer.address);
  await bridge.waitForDeployment();
  const bridgeAddress = await bridge.getAddress();
  console.log("BlozBridge:", bridgeAddress);

  const minterRole = await wBLOZ.MINTER_ROLE();
  if (operator.toLowerCase() !== deployer.address.toLowerCase()) {
    const tx = await wBLOZ.grantRole(minterRole, operator);
    await tx.wait();
    console.log("Granted MINTER_ROLE to operator");
  }

  const out = {
    network: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    operator,
    wBLOZ: wBLOZAddress,
    bridge: bridgeAddress,
    deployedAt: new Date().toISOString(),
  };

  const outPath = path.join(__dirname, "..", "deployments.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("Wrote", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
