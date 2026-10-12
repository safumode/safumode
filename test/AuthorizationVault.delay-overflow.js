const { expect } = require("chai");
const { ethers } = require("hardhat");

const Withdraw = [
  { name: "asset", type: "address" }, { name: "to", type: "address" },
  { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" }, { name: "immediate", type: "bool" },
];

describe("AuthorizationVault delay representation", function () {
  it("rejects a delay whose execution timestamps cannot fit in storage", async function () {
    const [, authorizer, recovery, recoveryRecipient] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("AuthorizationVault");
    await expect(factory.deploy(authorizer, recovery, recoveryRecipient, (1n << 64n) - 1n))
      .to.be.revertedWithCustomError(factory, "InvalidDelay");
  });

  it("stores the exact uint64 boundary for the largest currently valid delay", async function () {
    const [, authorizer, recovery, recoveryRecipient, recipient] = await ethers.getSigners();
    const maximumUint64 = (1n << 64n) - 1n;
    const latest = await ethers.provider.getBlock("latest");
    // Hardhat mines deployment and scheduling in successive seconds.
    const delay = maximumUint64 - BigInt(latest.timestamp) - 2n;
    const vault = await ethers.deployContract("AuthorizationVault", [authorizer, recovery, recoveryRecipient, delay]);
    const deploymentReceipt = await vault.deploymentTransaction().wait();
    const deploymentBlock = await ethers.provider.getBlock(deploymentReceipt.blockNumber);
    const deadline = BigInt(deploymentBlock.timestamp) + 100n;
    const value = { asset: ethers.ZeroAddress, to: recipient.address, amount: 0, nonce: 1, deadline, immediate: false };
    const domain = { name: "Authorization Vault Prototype", version: await vault.VERSION(), chainId: 31337, verifyingContract: await vault.getAddress() };
    const signature = await authorizer.signTypedData(domain, { Withdraw }, value);
    const id = await vault.scheduleWithdrawal.staticCall(value.asset, value.to, value.amount, value.nonce, value.deadline, signature);

    await vault.scheduleWithdrawal(value.asset, value.to, value.amount, value.nonce, value.deadline, signature);
    expect((await vault.requests(id)).executableAt).to.equal(maximumUint64);
  });
});
