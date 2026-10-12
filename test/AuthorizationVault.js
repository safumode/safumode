const { expect } = require("chai");
const { ethers } = require("hardhat");

const types = {
  Withdraw: [
    { name: "asset", type: "address" }, { name: "to", type: "address" },
    { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }, { name: "immediate", type: "bool" },
  ],
  SetTrusted: [
    { name: "account", type: "address" }, { name: "trusted", type: "bool" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
  Cancel: [
    { name: "requestId", type: "bytes32" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Recover: [
    { name: "asset", type: "address" }, { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
};

describe("AuthorizationVault", function () {
  let vault, token, falseToken, owner, authorizer, recovery, recoveryRecipient, trusted, stranger, relayer, domain;
  const delay = 3600;

  beforeEach(async function () {
    [owner, authorizer, recovery, recoveryRecipient, trusted, stranger, relayer] = await ethers.getSigners();
    vault = await ethers.deployContract("AuthorizationVault", [authorizer.address, recovery.address, recoveryRecipient.address, delay]);
    token = await ethers.deployContract("MockToken");
    falseToken = await ethers.deployContract("FalseToken");
    domain = { name: "Authorization Vault Prototype", version: "1", chainId: 31337, verifyingContract: await vault.getAddress() };
  });

  async function deadline() { return (await ethers.provider.getBlock("latest")).timestamp + 10000; }
  async function sign(signer, type, value) { return signer.signTypedData(domain, { [type]: types[type] }, value); }
  async function scheduleTrust(account, nonce = 1) {
    const d = await deadline();
    const value = { account: account.address, trusted: true, nonce, deadline: d };
    await vault.scheduleTrust(account, nonce, d, await sign(authorizer, "SetTrusted", value), await sign(recovery, "SetTrusted", value));
    return { d, value };
  }
  async function activate(account, nonce = 1) {
    await ethers.provider.send("evm_increaseTime", [delay]); await ethers.provider.send("evm_mine");
    await vault.activateTrust(account, nonce);
  }

  it("accepts deposits and rejects false-returning tokens", async function () {
    await expect(owner.sendTransaction({ to: vault, value: 5n })).to.emit(vault, "NativeDeposited");
    await token.mint(owner, 100n); await token.approve(vault, 40n); await vault.depositToken(token, 40n);
    expect(await token.balanceOf(vault)).to.equal(40n);
    await expect(vault.depositToken(falseToken, 1n)).to.be.revertedWithCustomError(vault, "TransferFailed");
  });

  it("requires recovery co-signature and delayed activation before immediate withdrawal", async function () {
    await owner.sendTransaction({ to: vault, value: 50n });
    const d = await deadline();
    const value = { account: trusted.address, trusted: true, nonce: 1, deadline: d };
    const primarySig = await sign(authorizer, "SetTrusted", value);
    await expect(vault.scheduleTrust(trusted, 1, d, primarySig, primarySig)).to.be.revertedWithCustomError(vault, "InvalidSignature");
    await scheduleTrust(trusted);
    expect(await vault.trusted(trusted)).to.equal(false);
    await expect(vault.activateTrust(trusted, 1)).to.be.revertedWithCustomError(vault, "TooEarly");
    let wd = await deadline();
    let sig = await sign(authorizer, "Withdraw", { asset: ethers.ZeroAddress, to: trusted.address, amount: 20, nonce: 2, deadline: wd, immediate: true });
    await expect(vault.withdrawTrusted(ethers.ZeroAddress, trusted, 20, 2, wd, sig)).to.be.revertedWithCustomError(vault, "RecipientTrustMismatch");
    await activate(trusted);
    wd = await deadline(); sig = await sign(authorizer, "Withdraw", { asset: ethers.ZeroAddress, to: trusted.address, amount: 20, nonce: 2, deadline: wd, immediate: true });
    await vault.withdrawTrusted(ethers.ZeroAddress, trusted, 20, 2, wd, sig);
    expect(await ethers.provider.getBalance(vault)).to.equal(30n);
  });

  it("immediately revokes and stale pending activation cannot undo revocation", async function () {
    await scheduleTrust(trusted, 1);
    const d = await deadline();
    const revoke = { account: trusted.address, trusted: false, nonce: 2, deadline: d };
    await vault.revokeTrust(trusted, 2, d, await sign(authorizer, "SetTrusted", revoke));
    expect(await vault.trustNonce(trusted)).to.equal(2n);
    await ethers.provider.send("evm_increaseTime", [delay]); await ethers.provider.send("evm_mine");
    await expect(vault.activateTrust(trusted, 1)).to.be.revertedWithCustomError(vault, "TrustChangeMissing");
    expect(await vault.trusted(trusted)).to.equal(false);
  });

  it("strict per-recipient nonce ordering blocks replay, gaps, and revocation resurrection", async function () {
    const d = await deadline();
    const add1 = { account: trusted.address, trusted: true, nonce: 1, deadline: d };
    const a1 = await sign(authorizer, "SetTrusted", add1), r1 = await sign(recovery, "SetTrusted", add1);
    await vault.scheduleTrust(trusted, 1, d, a1, r1);
    await expect(vault.scheduleTrust(trusted, 1, d, a1, r1)).to.be.revertedWithCustomError(vault, "InvalidTrustNonce");
    const add3 = { account: trusted.address, trusted: true, nonce: 3, deadline: d };
    await expect(vault.scheduleTrust(trusted, 3, d, await sign(authorizer, "SetTrusted", add3), await sign(recovery, "SetTrusted", add3))).to.be.revertedWithCustomError(vault, "InvalidTrustNonce");
    const rev2 = { account: trusted.address, trusted: false, nonce: 2, deadline: d };
    await vault.revokeTrust(trusted, 2, d, await sign(authorizer, "SetTrusted", rev2));
    await expect(vault.scheduleTrust(trusted, 1, d, a1, r1)).to.be.revertedWithCustomError(vault, "InvalidTrustNonce");
  });

  it("rejects a zero-delay deployment", async function () {
    await expect(ethers.deployContract("AuthorizationVault", [authorizer.address, recovery.address, recoveryRecipient.address, 0]))
      .to.be.revertedWithCustomError(vault, "InvalidDelay");
  });

  it("timelocks untrusted withdrawal and recovery can cancel it", async function () {
    await token.mint(owner, 100n); await token.approve(vault, 100n); await vault.depositToken(token, 100n);
    const d = await deadline();
    const value = { asset: await token.getAddress(), to: stranger.address, amount: 35, nonce: 3, deadline: d, immediate: false };
    const sig = await sign(authorizer, "Withdraw", value);
    const id = await vault.scheduleWithdrawal.staticCall(value.asset, value.to, value.amount, value.nonce, d, sig);
    await vault.scheduleWithdrawal(value.asset, value.to, value.amount, value.nonce, d, sig);
    await expect(vault.executeWithdrawal(id)).to.be.revertedWithCustomError(vault, "TooEarly");
    const cancelSig = await sign(recovery, "Cancel", { requestId: id, nonce: 7, deadline: d });
    await vault.cancelWithdrawal(id, true, 7, d, cancelSig);
    await expect(vault.executeWithdrawal(id)).to.be.revertedWithCustomError(vault, "RequestMissing");
  });

  it("break-glass recovery pays only the fixed recipient", async function () {
    await token.mint(owner, 20n); await token.approve(vault, 20n); await vault.depositToken(token, 20n);
    const d = await deadline();
    const sig = await sign(recovery, "Recover", { asset: await token.getAddress(), amount: 20, nonce: 9, deadline: d });
    await vault.recover(token, 20, 9, d, sig);
    expect(await token.balanceOf(recoveryRecipient)).to.equal(20n);
  });
});
