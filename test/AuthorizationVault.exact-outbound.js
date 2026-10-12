const { expect } = require("chai");
const { ethers } = require("hardhat");

const Withdraw = [
  { name: "asset", type: "address" }, { name: "to", type: "address" },
  { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" }, { name: "immediate", type: "bool" },
];
const Recover = [
  { name: "asset", type: "address" }, { name: "amount", type: "uint256" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
];
const SetTrusted = [
  { name: "account", type: "address" }, { name: "trusted", type: "bool" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
];

describe("AuthorizationVault exact outbound ERC20 accounting", function () {
  const delay = 60;
  const amount = 100n;
  let vault, authorizer, recovery, recoveryRecipient, trusted, delayed, domain;

  beforeEach(async function () {
    [, authorizer, recovery, recoveryRecipient, trusted, delayed] = await ethers.getSigners();
    vault = await ethers.deployContract("AuthorizationVault", [authorizer, recovery, recoveryRecipient, delay]);
    domain = { name: "Authorization Vault Prototype", version: await vault.VERSION(), chainId: 31337,
      verifyingContract: await vault.getAddress() };
    const d = await deadline();
    const value = { account: trusted.address, trusted: true, nonce: 1, deadline: d };
    await vault.scheduleTrust(trusted, 1, d, await sign(authorizer, "SetTrusted", SetTrusted, value),
      await sign(recovery, "SetTrusted", SetTrusted, value));
    await ethers.provider.send("evm_increaseTime", [delay]);
    await ethers.provider.send("evm_mine");
    await vault.activateTrust(trusted, 1);
  });

  async function deadline() { return (await ethers.provider.getBlock("latest")).timestamp + 10000; }
  async function sign(signer, name, fields, value) { return signer.signTypedData(domain, { [name]: fields }, value); }

  for (const tokenName of ["FeeToken", "SenderFeeToken"]) {
    describe(tokenName, function () {
      let token, asset;
      beforeEach(async function () {
        token = await ethers.deployContract(tokenName);
        asset = await token.getAddress();
        await token.mint(vault, 1000n);
      });

      it("reverts recover and rolls back token movement and recovery nonce", async function () {
        const d = await deadline(), value = { asset, amount, nonce: 41, deadline: d };
        await expect(vault.recover(asset, amount, 41, d, await sign(recovery, "Recover", Recover, value)))
          .to.be.revertedWithCustomError(vault, "ExactTransferMismatch");
        expect(await vault.recoveryNonceUsed(41)).to.equal(false);
        expect(await token.balanceOf(vault)).to.equal(1000n);
        expect(await token.balanceOf(recoveryRecipient)).to.equal(0n);
      });

      it("reverts withdrawTrusted and rolls back token movement and authorizer nonce", async function () {
        const d = await deadline();
        const value = { asset, to: trusted.address, amount, nonce: 42, deadline: d, immediate: true };
        await expect(vault.withdrawTrusted(asset, trusted, amount, 42, d,
          await sign(authorizer, "Withdraw", Withdraw, value)))
          .to.be.revertedWithCustomError(vault, "ExactTransferMismatch");
        expect(await vault.authorizerNonceUsed(42)).to.equal(false);
        expect(await token.balanceOf(vault)).to.equal(1000n);
        expect(await token.balanceOf(trusted)).to.equal(0n);
      });

      it("reverts executeWithdrawal and rolls back token movement and executed flag", async function () {
        const d = await deadline();
        const value = { asset, to: delayed.address, amount, nonce: 43, deadline: d, immediate: false };
        const signature = await sign(authorizer, "Withdraw", Withdraw, value);
        const id = await vault.scheduleWithdrawal.staticCall(asset, delayed, amount, 43, d, signature);
        await vault.scheduleWithdrawal(asset, delayed, amount, 43, d, signature);
        await ethers.provider.send("evm_increaseTime", [delay]);
        await ethers.provider.send("evm_mine");
        await expect(vault.executeWithdrawal(id)).to.be.revertedWithCustomError(vault, "ExactTransferMismatch");
        expect((await vault.requests(id)).executed).to.equal(false);
        expect(await token.balanceOf(vault)).to.equal(1000n);
        expect(await token.balanceOf(delayed)).to.equal(0n);
      });
    });
  }

  it("keeps native transfers unaffected", async function () {
    await authorizer.sendTransaction({ to: vault, value: amount });
    const d = await deadline(), value = { asset: ethers.ZeroAddress, amount, nonce: 50, deadline: d };
    await expect(vault.recover(ethers.ZeroAddress, amount, 50, d,
      await sign(recovery, "Recover", Recover, value))).to.emit(vault, "RecoveryExecuted");
  });

  it("accepts a conventional zero transfer and rejects a positive ERC20 self-transfer", async function () {
    const token = await ethers.deployContract("MockToken"), asset = await token.getAddress();
    await token.mint(vault, amount);
    let d = await deadline(), value = { asset, amount: 0, nonce: 60, deadline: d };
    await expect(vault.recover(asset, 0, 60, d, await sign(recovery, "Recover", Recover, value)))
      .to.emit(vault, "RecoveryExecuted");
    d = await deadline();
    const self = { asset, to: await vault.getAddress(), amount: 1, nonce: 61, deadline: d, immediate: false };
    const sig = await sign(authorizer, "Withdraw", Withdraw, self);
    const id = await vault.scheduleWithdrawal.staticCall(asset, self.to, 1, 61, d, sig);
    await vault.scheduleWithdrawal(asset, self.to, 1, 61, d, sig);
    await ethers.provider.send("evm_increaseTime", [delay]);
    await ethers.provider.send("evm_mine");
    await expect(vault.executeWithdrawal(id)).to.be.revertedWithCustomError(vault, "ExactTransferMismatch");
    expect((await vault.requests(id)).executed).to.equal(false);
  });
});
