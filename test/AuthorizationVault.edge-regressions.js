const { expect } = require("chai");
const { ethers } = require("hardhat");

const TYPES = {
  Withdraw: [
    { name: "asset", type: "address" }, { name: "to", type: "address" },
    { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }, { name: "immediate", type: "bool" },
  ],
  Cancel: [
    { name: "requestId", type: "bytes32" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  SetPaused: [
    { name: "paused", type: "bool" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  RotateAuthorities: [
    { name: "authorizer", type: "address" }, { name: "recoveryAuthorizer", type: "address" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
  CancelRotation: [
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
};

// Independent regression coverage for state-machine boundaries where timing,
// authority epochs, nonce mutation, pause state, and transfers interact.
describe("AuthorizationVault timing/rotation/nonce/pause/asset-flow edge regressions", function () {
  const delay = 3600;
  let vault, token, authorizer, recovery, recoveryRecipient, recipient;
  let nextAuthorizer, nextRecovery, alternateAuthorizer, alternateRecovery, domain;

  beforeEach(async function () {
    [, authorizer, recovery, recoveryRecipient, recipient,
      nextAuthorizer, nextRecovery, alternateAuthorizer, alternateRecovery] = await ethers.getSigners();
    vault = await ethers.deployContract("AuthorizationVault", [authorizer, recovery, recoveryRecipient, delay]);
    token = await ethers.deployContract("MockToken");
    domain = {
      name: "Authorization Vault Prototype",
      version: await vault.VERSION(),
      chainId: 31337,
      verifyingContract: await vault.getAddress(),
    };
  });

  async function timestamp() { return (await ethers.provider.getBlock("latest")).timestamp; }
  async function sign(signer, type, value) {
    return signer.signTypedData(domain, { [type]: TYPES[type] }, value);
  }
  async function scheduleNative(nonce, amount = 1n) {
    const value = {
      asset: ethers.ZeroAddress, to: recipient.address, amount, nonce,
      deadline: (await timestamp()) + 20_000, immediate: false,
    };
    const signature = await sign(authorizer, "Withdraw", value);
    const id = await vault.scheduleWithdrawal.staticCall(
      value.asset, value.to, value.amount, value.nonce, value.deadline, signature
    );
    await vault.scheduleWithdrawal(value.asset, value.to, value.amount, value.nonce, value.deadline, signature);
    return { id, value };
  }
  async function scheduleRotation(a, r, nonce) {
    const value = {
      authorizer: a.address, recoveryAuthorizer: r.address, nonce,
      deadline: (await timestamp()) + 20_000,
    };
    await vault.scheduleRotation(value.authorizer, value.recoveryAuthorizer, nonce, value.deadline,
      await sign(authorizer, "RotateAuthorities", value), await sign(recovery, "RotateAuthorities", value));
    return value;
  }

  it("activates rotation at the exact boundary and makes the old domain unusable immediately", async function () {
    await scheduleRotation(nextAuthorizer, nextRecovery, 1);
    const executableAt = Number((await vault.pendingRotation()).executableAt);

    await ethers.provider.send("evm_setNextBlockTimestamp", [executableAt - 1]);
    await expect(vault.activateRotation(1)).to.be.revertedWithCustomError(vault, "TooEarly");
    await ethers.provider.send("evm_setNextBlockTimestamp", [executableAt]);
    await expect(vault.activateRotation(1)).to.emit(vault, "AuthoritiesRotated");

    const stale = {
      asset: ethers.ZeroAddress, to: recipient.address, amount: 0, nonce: 88,
      deadline: executableAt + 1000, immediate: false,
    };
    await expect(vault.scheduleWithdrawal(stale.asset, stale.to, stale.amount, stale.nonce, stale.deadline,
      await sign(authorizer, "Withdraw", stale))).to.be.revertedWithCustomError(vault, "InvalidSignature");
  });

  it("supersedes an older pending rotation and only the latest nonce can activate", async function () {
    await scheduleRotation(nextAuthorizer, nextRecovery, 1);
    await scheduleRotation(alternateAuthorizer, alternateRecovery, 2);
    const latestAt = Number((await vault.pendingRotation()).executableAt);
    await ethers.provider.send("evm_setNextBlockTimestamp", [latestAt]);

    await expect(vault.activateRotation(1)).to.be.revertedWithCustomError(vault, "RotationMissing");
    await vault.activateRotation(2);
    expect(await vault.authorizer()).to.equal(alternateAuthorizer.address);
    expect(await vault.recoveryAuthorizer()).to.equal(alternateRecovery.address);
    expect(await vault.rotationNonce()).to.equal(2n);
  });

  it("blocks rotation scheduling while paused without mutating nonce, epoch, or pending state", async function () {
    const d = (await timestamp()) + 20_000;
    const pause = { paused: true, nonce: 1, deadline: d };
    await vault.setPaused(true, false, 1, d, await sign(authorizer, "SetPaused", pause), "0x");
    const rotation = {
      authorizer: nextAuthorizer.address, recoveryAuthorizer: nextRecovery.address,
      nonce: 1, deadline: d,
    };

    await expect(vault.scheduleRotation(rotation.authorizer, rotation.recoveryAuthorizer,
      rotation.nonce, rotation.deadline, await sign(authorizer, "RotateAuthorities", rotation),
      await sign(recovery, "RotateAuthorities", rotation)))
      .to.be.revertedWithCustomError(vault, "Paused");
    expect(await vault.rotationNonce()).to.equal(0n);
    expect(await vault.authorityEpoch()).to.equal(0n);
    expect((await vault.pendingRotation()).executableAt).to.equal(0n);
    expect(await vault.authorizer()).to.equal(authorizer.address);
    expect(await vault.recoveryAuthorizer()).to.equal(recovery.address);
  });

  it("blocks matured rotation activation while paused, then permits it after 2-of-2 resume", async function () {
    await scheduleRotation(nextAuthorizer, nextRecovery, 1);
    const pendingBefore = await vault.pendingRotation();
    const d = Number(pendingBefore.executableAt) + 20_000;
    const pause = { paused: true, nonce: 1, deadline: d };
    await vault.setPaused(true, true, 1, d, await sign(recovery, "SetPaused", pause), "0x");
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(pendingBefore.executableAt)]);

    await expect(vault.activateRotation(1)).to.be.revertedWithCustomError(vault, "Paused");
    const pendingAfter = await vault.pendingRotation();
    expect(pendingAfter.authorizer).to.equal(pendingBefore.authorizer);
    expect(pendingAfter.recoveryAuthorizer).to.equal(pendingBefore.recoveryAuthorizer);
    expect(pendingAfter.executableAt).to.equal(pendingBefore.executableAt);
    expect(pendingAfter.nonce).to.equal(pendingBefore.nonce);
    expect(await vault.rotationNonce()).to.equal(1n);
    expect(await vault.authorityEpoch()).to.equal(0n);
    expect(await vault.authorizer()).to.equal(authorizer.address);
    expect(await vault.recoveryAuthorizer()).to.equal(recovery.address);

    const resumeDeadline = (await timestamp()) + 20_000;
    const resume = { paused: false, nonce: 2, deadline: resumeDeadline };
    await vault.setPaused(false, false, 2, resumeDeadline,
      await sign(authorizer, "SetPaused", resume), await sign(recovery, "SetPaused", resume));
    await expect(vault.activateRotation(1)).to.emit(vault, "AuthoritiesRotated");
    expect(await vault.authorityEpoch()).to.equal(1n);
    expect(await vault.authorizer()).to.equal(nextAuthorizer.address);
    expect(await vault.recoveryAuthorizer()).to.equal(nextRecovery.address);
  });

  for (const veto of [
    { label: "authorizer", byRecovery: false },
    { label: "recovery authorizer", byRecovery: true },
  ]) {
    it(`allows unilateral ${veto.label} rotation veto while paused`, async function () {
      await scheduleRotation(nextAuthorizer, nextRecovery, 1);
      const d = (await timestamp()) + 20_000;
      const pause = { paused: true, nonce: 1, deadline: d };
      await vault.setPaused(true, false, 1, d, await sign(authorizer, "SetPaused", pause), "0x");
      const cancel = { nonce: 1, deadline: d };
      const signer = veto.byRecovery ? recovery : authorizer;

      await expect(vault.cancelRotation(veto.byRecovery, cancel.nonce, cancel.deadline,
        await sign(signer, "CancelRotation", cancel)))
        .to.emit(vault, "RotationCancelled").withArgs(1, signer.address);
      expect((await vault.pendingRotation()).executableAt).to.equal(0n);
      expect(await vault.rotationNonce()).to.equal(1n);
      expect(await vault.authorityEpoch()).to.equal(0n);

      const resumeDeadline = (await timestamp()) + 20_000;
      const resume = { paused: false, nonce: 2, deadline: resumeDeadline };
      await vault.setPaused(false, false, 2, resumeDeadline,
        await sign(authorizer, "SetPaused", resume), await sign(recovery, "SetPaused", resume));
      await expect(vault.activateRotation(1)).to.be.revertedWithCustomError(vault, "RotationMissing");
    });
  }

  it("does not consume an immediate-withdrawal nonce when token transfer fails", async function () {
    const value = {
      asset: await token.getAddress(), to: recipient.address, amount: 7, nonce: 501,
      deadline: (await timestamp()) + 10_000, immediate: true,
    };
    const signature = await sign(authorizer, "Withdraw", value);
    await expect(vault.withdrawTrusted(value.asset, value.to, value.amount, value.nonce, value.deadline, signature))
      .to.be.revertedWithCustomError(vault, "RecipientTrustMismatch");
    // Establishing trust is deliberately avoided here: force token failure through recovery's fixed recipient.
    const Recover = [
      { name: "asset", type: "address" }, { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ];
    const recoverValue = { asset: value.asset, amount: 7, nonce: 501, deadline: value.deadline };
    const recoverySignature = await recovery.signTypedData(domain, { Recover }, recoverValue);
    await expect(vault.recover(value.asset, 7, 501, value.deadline, recoverySignature))
      .to.be.revertedWithCustomError(vault, "TransferFailed");
    expect(await vault.recoveryNonceUsed(501)).to.equal(false);

    await token.mint(vault, 7);
    await expect(vault.recover(value.asset, 7, 501, value.deadline, recoverySignature))
      .to.emit(vault, "RecoveryExecuted");
    expect(await vault.recoveryNonceUsed(501)).to.equal(true);
    expect(await token.balanceOf(recoveryRecipient)).to.equal(7n);
  });

  it("rolls back a matured request's executed flag on transfer failure and permits retry after funding", async function () {
    const value = {
      asset: await token.getAddress(), to: recipient.address, amount: 11, nonce: 601,
      deadline: (await timestamp()) + 20_000, immediate: false,
    };
    const signature = await sign(authorizer, "Withdraw", value);
    const id = await vault.scheduleWithdrawal.staticCall(value.asset, value.to, value.amount, value.nonce, value.deadline, signature);
    await vault.scheduleWithdrawal(value.asset, value.to, value.amount, value.nonce, value.deadline, signature);
    const at = Number((await vault.requests(id)).executableAt);
    await ethers.provider.send("evm_setNextBlockTimestamp", [at]);

    await expect(vault.executeWithdrawal(id)).to.be.revertedWithCustomError(vault, "TransferFailed");
    expect((await vault.requests(id)).executed).to.equal(false);
    await token.mint(vault, 11);
    await expect(vault.executeWithdrawal(id)).to.emit(vault, "WithdrawalExecuted");
    expect((await vault.requests(id)).executed).to.equal(true);
    expect(await token.balanceOf(recipient)).to.equal(11n);
  });

  it("allows deposits and emergency cancellation while paused, but blocks matured outflow until resumed", async function () {
    const queued = await scheduleNative(701, 3n);
    const pauseDeadline = (await timestamp()) + 20_000;
    const pause = { paused: true, nonce: 1, deadline: pauseDeadline };
    await vault.setPaused(true, false, 1, pauseDeadline, await sign(authorizer, "SetPaused", pause), "0x");

    await expect(recipient.sendTransaction({ to: vault, value: 3n })).to.emit(vault, "NativeDeposited");
    await token.mint(recipient, 5); await token.connect(recipient).approve(vault, 5);
    await expect(vault.connect(recipient).depositToken(token, 5)).to.emit(vault, "TokenDeposited");
    const at = Number((await vault.requests(queued.id)).executableAt);
    await ethers.provider.send("evm_setNextBlockTimestamp", [at]);
    await expect(vault.executeWithdrawal(queued.id)).to.be.revertedWithCustomError(vault, "Paused");

    const cancel = { requestId: queued.id, nonce: 702, deadline: pauseDeadline };
    await expect(vault.cancelWithdrawal(queued.id, true, cancel.nonce, cancel.deadline,
      await sign(recovery, "Cancel", cancel))).to.emit(vault, "WithdrawalCancelled");
    expect(await vault.recoveryNonceUsed(cancel.nonce)).to.equal(true);
    await expect(vault.executeWithdrawal(queued.id)).to.be.revertedWithCustomError(vault, "Paused");
  });

  it("shares the primary nonce namespace between cancellation and withdrawals without partial mutation", async function () {
    const queued = await scheduleNative(801);
    const d = (await timestamp()) + 10_000;
    const cancel = { requestId: queued.id, nonce: 900, deadline: d };
    await vault.cancelWithdrawal(queued.id, false, cancel.nonce, d, await sign(authorizer, "Cancel", cancel));

    const withdrawal = {
      asset: ethers.ZeroAddress, to: recoveryRecipient.address, amount: 0,
      nonce: 900, deadline: d, immediate: false,
    };
    await expect(vault.scheduleWithdrawal(withdrawal.asset, withdrawal.to, withdrawal.amount,
      withdrawal.nonce, withdrawal.deadline, await sign(authorizer, "Withdraw", withdrawal)))
      .to.be.revertedWithCustomError(vault, "NonceUsed");
    expect(await vault.authorizerNonceUsed(900)).to.equal(true);
  });
});
