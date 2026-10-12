"use strict";
const { expect } = require("chai");
const { ethers } = require("ethers");
const { typedMessage, signWithLedger } = require("../scripts/safumode-ledger");

describe("Ledger local signing boundary", () => {
  const wallet = ethers.Wallet.createRandom();
  const bundle = {
    schema: "safumode-typed-transaction-v1", action: "recover",
    domain: { name: "Authorization Vault Prototype", version: "1:0", chainId: "31337", verifyingContract: ethers.Wallet.createRandom().address },
    primaryType: "Recover", types: { Recover: [{name:"asset",type:"address"},{name:"amount",type:"uint256"},{name:"nonce",type:"uint256"},{name:"deadline",type:"uint256"}] },
    message: { asset: ethers.ZeroAddress, amount: "1", nonce: "0", deadline: "9999999999" },
    expectedSigners: { recoveryAuthorizer: wallet.address },
  };
  it("formats clear-signable EIP-712 data with the same digest", () => {
    const msg = typedMessage(bundle);
    expect(ethers.TypedDataEncoder.hash(msg.domain, { Recover: msg.types.Recover }, msg.message)).to.equal(ethers.TypedDataEncoder.hash(bundle.domain,bundle.types,bundle.message));
    expect(msg.types.EIP712Domain.map(x=>x.name)).to.deep.equal(["name","version","chainId","verifyingContract"]);
  });
  it("rejects production chain before touching a device", async () => {
    await expect(signWithLedger({...bundle,domain:{...bundle.domain,chainId:"56"}},"recoveryAuthorizer",undefined,async()=>{throw Error("device opened")})).to.be.rejectedWith("restricted to the local Hardhat vault");
  });
  it("rejects wrong role and derivation path before touching a device", async () => {
    await expect(signWithLedger(bundle,"authorizer")).to.be.rejectedWith("role is not required");
    await expect(signWithLedger(bundle,"recoveryAuthorizer","bad")).to.be.rejectedWith("invalid Ledger Ethereum derivation path");
  });
});
