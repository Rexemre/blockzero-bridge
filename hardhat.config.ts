import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const deployerKey = process.env.BSC_DEPLOYER_PRIVATE_KEY ?? "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  etherscan: {
    apiKey: process.env.BSCSCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY ?? "",
  },
  sourcify: {
    enabled: true,
  },
  networks: {
    bsc: {
      url: process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org/",
      chainId: 56,
      accounts: deployerKey ? [deployerKey] : [],
    },
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC_URL ?? "https://data-seed-prebsc-1-s1.binance.org:8545/",
      chainId: 97,
      accounts: deployerKey ? [deployerKey] : [],
    },
  },
};

export default config;
