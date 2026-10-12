"use strict";
const { ethers } = require("ethers");
const { digest } = require("./safumode-tx");

const DEFAULT_PATH = "44'/60'/0'/0/0";
function typedMessage(bundle) {
  if (!bundle || bundle.schema !== "safumode-typed-transaction-v1") throw new Error("invalid SAFUMODE typed bundle");
  return {
    domain: bundle.domain,
    primaryType: bundle.primaryType,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" }, { name: "version", type: "string" },
        { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
      ],
      ...bundle.types,
    },
    message: bundle.message,
  };
}
async function signWithLedger(bundle, role, path = DEFAULT_PATH, openTransport) {
  if (!/^(44'\/60'\/[0-9]+'\/0\/[0-9]+)$/.test(path)) throw new Error("invalid Ledger Ethereum derivation path");
  const expected = bundle && bundle.expectedSigners && bundle.expectedSigners[role];
  if (!expected || !["authorizer", "recoveryAuthorizer"].includes(role)) throw new Error("role is not required by this bundle");
  // Local test-chain signatures only. Never allow the hardware key to sign a production authorization here.
  if (bundle.domain.chainId !== "31337" || bundle.domain.name !== "Authorization Vault Prototype") throw new Error("Ledger signing is restricted to the local Hardhat vault");
  const message = typedMessage(bundle);
  const transport = await (openTransport || (async () => {
    const Transport = require("@ledgerhq/hw-transport-node-hid").default;
    return Transport.create();
  }))();
  try {
    const Eth = require("@ledgerhq/hw-app-eth").default;
    const eth = new Eth(transport);
    const { address } = await eth.getAddress(path, true);
    if (ethers.getAddress(address) !== ethers.getAddress(expected)) throw new Error(`Ledger address does not match ${role} in bundle`);
    // Clear EIP-712 signing only. Do not silently fall back to blind hash signing.
    const { r, s, v } = await eth.signEIP712Message(path, message);
    const signature = ethers.Signature.from({ r: `0x${r.replace(/^0x/, "")}`, s: `0x${s.replace(/^0x/, "")}`, v }).serialized;
    if (ethers.verifyTypedData(bundle.domain, bundle.types, bundle.message, signature) !== ethers.getAddress(expected)) throw new Error("Ledger signature does not match expected signer");
    return { role, address: ethers.getAddress(expected), digest: digest(bundle), signature };
  } finally { await transport.close(); }
}
module.exports = { DEFAULT_PATH, typedMessage, signWithLedger };
