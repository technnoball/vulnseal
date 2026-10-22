// Hardhat is used only to compile the contract and to run a local, in-memory
// development chain bound to 127.0.0.1. No public network is configured.
/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: { sources: "./contracts", artifacts: "./build/artifacts", cache: "./build/cache" },
  networks: {
    hardhat: { chainId: 31337 },
  },
};
