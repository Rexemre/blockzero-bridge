import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const deployerKey = process.env.BSC_DEPLOYER_PRIVATE_KEY ?? "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
  },
  etherscan: {
    apiKey: process.env.BSCSCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY ?? "",
  },
  networks: {
    bsc: {
      url: process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org/",
      chainId: 56,
      accounts: deployerKey ? [deployerKey] : [],
    },
    hardhat: { chainId: 31337 },
  },
};

export default config;
