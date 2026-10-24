// Hardhat compiles the contract and runs a local, in-memory chain on 127.0.0.1.
// VS_CHAIN_INITIAL_DATE lets run.sh start the chain in the past so the transaction
// journal can be replayed with its original block times (see server/journal.ts).
/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: { sources: "./contracts", artifacts: "./build/artifacts", cache: "./build/cache" },
  networks: {
    hardhat: {
      chainId: 31337,
      ...(process.env.VS_CHAIN_INITIAL_DATE ? { initialDate: process.env.VS_CHAIN_INITIAL_DATE } : {}),
    },
  },
};
