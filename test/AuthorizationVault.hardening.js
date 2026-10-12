const { expect } = require("chai");
const { ethers } = require("hardhat");

const Pause = [
  { name: "paused", type: "bool" }, { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
];
const Rotate = [
  { name: "authorizer", type: "address" }, { name: "recoveryAuthorizer", type: "address" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
];
const CancelRotation = [
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
];
const Recover = [
  { name: "asset", type: "address" }, { name: "amount", type: "uint256" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
];
const Withdraw = [
  { name: "asset", type: "address" }, { name: "to", type: "address" },
  { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" }, { name: "immediate", type: "bool" },
];
const SetTrusted = [
  { name: "account", type: "address" }, { name: "trusted", type: "bool" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
];

describe("AuthorizationVault hardening properties", function () {
  let vault, authorizer, recovery, recipient, nextAuthorizer, nextRecovery, depositor, domain;
  const delay = 3600;

  beforeEach(async function () {
    [, authorizer, recovery, recipient, nextAuthorizer, nextRecovery, depositor] = await ethers.getSigners();
    vault = await ethers.deployContract("AuthorizationVault", [authorizer, recovery, recipient, delay]);
    domain = { name: "Authorization Vault Prototype", version: await vault.VERSION(), chainId: 31337, verifyingContract: await vault.getAddress() };
  });

  async function deadline() { return (await ethers.provider.getBlock("latest")).timestamp + 10000; }
  async function sign(signer, name, fields, value) {
    return signer.signTypedData(domain, { [name]: fields }, value);
  }

  it("permits unilateral emergency pause, but requires both authorities to resume", async function () {
    await depositor.sendTransaction({ to: vault, value: 10n });
    let d = await deadline();
    let value = { paused: true, nonce: 1, deadline: d };
    await vault.setPaused(true, true, 1, d, await sign(recovery, "SetPaused", Pause, value), "0x");

    const recover = { asset: ethers.ZeroAddress, amount: 1, nonce: 77, deadline: d };
    const recoverySig = await sign(recovery, "Recover", Recover, recover);
    await expect(vault.recover(recover.asset, recover.amount, recover.nonce, d, recoverySig))
      .to.be.revertedWithCustomError(vault, "Paused");
    expect(await vault.recoveryNonceUsed(77)).to.equal(false);

    d = await deadline(); value = { paused: false, nonce: 2, deadline: d };
    const primarySig = await sign(authorizer, "SetPaused", Pause, value);
    await expect(vault.setPaused(false, false, 2, d, primarySig, primarySig))
      .to.be.revertedWithCustomError(vault, "InvalidSignature");
    await vault.setPaused(false, false, 2, d, primarySig, await sign(recovery, "SetPaused", Pause, value));
    expect(await vault.paused()).to.equal(false);
  });

  it("rotates only with 2-of-2 approval and a delay, then rejects old authority signatures", async function () {
    const d = await deadline();
    const rotation = { authorizer: nextAuthorizer.address, recoveryAuthorizer: nextRecovery.address, nonce: 1, deadline: d };
    const primarySig = await sign(authorizer, "RotateAuthorities", Rotate, rotation);
    await expect(vault.scheduleRotation(rotation.authorizer, rotation.recoveryAuthorizer, 1, d, primarySig, primarySig))
      .to.be.revertedWithCustomError(vault, "InvalidSignature");
    await vault.scheduleRotation(rotation.authorizer, rotation.recoveryAuthorizer, 1, d, primarySig,
      await sign(recovery, "RotateAuthorities", Rotate, rotation));
    await expect(vault.activateRotation(1)).to.be.revertedWithCustomError(vault, "TooEarly");
    await ethers.provider.send("evm_increaseTime", [delay]); await ethers.provider.send("evm_mine");
    await vault.activateRotation(1);
    expect(await vault.authorizer()).to.equal(nextAuthorizer.address);
    expect(await vault.recoveryAuthorizer()).to.equal(nextRecovery.address);

    const p = { paused: true, nonce: 1, deadline: d };
    await expect(vault.setPaused(true, false, 1, d, await sign(authorizer, "SetPaused", Pause, p), "0x"))
      .to.be.revertedWithCustomError(vault, "InvalidSignature");
  });

  it("allows either current authority to unilaterally veto a pending rotation", async function () {
    for (const [vetoer, byRecovery, nonce] of [[authorizer, false, 1], [recovery, true, 2]]) {
      const d = await deadline();
      const rotation = { authorizer: nextAuthorizer.address, recoveryAuthorizer: nextRecovery.address, nonce, deadline: d };
      await vault.scheduleRotation(rotation.authorizer, rotation.recoveryAuthorizer, nonce, d,
        await sign(authorizer, "RotateAuthorities", Rotate, rotation),
        await sign(recovery, "RotateAuthorities", Rotate, rotation));
      const veto = { nonce, deadline: d };
      await expect(vault.cancelRotation(byRecovery, nonce, d, await sign(vetoer, "CancelRotation", CancelRotation, veto)))
        .to.emit(vault, "RotationCancelled").withArgs(nonce, vetoer.address);
      await ethers.provider.send("evm_increaseTime", [delay]); await ethers.provider.send("evm_mine");
      await expect(vault.activateRotation(nonce)).to.be.revertedWithCustomError(vault, "RotationMissing");
    }
  });

  it("rejects a rotation veto signed by the wrong authority", async function () {
    const d = await deadline();
    const rotation = { authorizer: nextAuthorizer.address, recoveryAuthorizer: nextRecovery.address, nonce: 1, deadline: d };
    await vault.scheduleRotation(rotation.authorizer, rotation.recoveryAuthorizer, 1, d,
      await sign(authorizer, "RotateAuthorities", Rotate, rotation), await sign(recovery, "RotateAuthorities", Rotate, rotation));
    const veto = { nonce: 1, deadline: d };
    await expect(vault.cancelRotation(false, 1, d, await sign(recovery, "CancelRotation", CancelRotation, veto)))
      .to.be.revertedWithCustomError(vault, "InvalidSignature");
  });

  it("never permits rotating back to a retired key (old-signature resurrection property)", async function () {
    let d = await deadline();
    let r = { authorizer: nextAuthorizer.address, recoveryAuthorizer: nextRecovery.address, nonce: 1, deadline: d };
    await vault.scheduleRotation(r.authorizer, r.recoveryAuthorizer, 1, d,
      await sign(authorizer, "RotateAuthorities", Rotate, r), await sign(recovery, "RotateAuthorities", Rotate, r));
    await ethers.provider.send("evm_increaseTime", [delay]); await ethers.provider.send("evm_mine");
    await vault.activateRotation(1);
    d = await deadline();
    r = { authorizer: authorizer.address, recoveryAuthorizer: recovery.address, nonce: 2, deadline: d };
    await expect(vault.scheduleRotation(r.authorizer, r.recoveryAuthorizer, 2, d, "0x", "0x"))
      .to.be.revertedWithCustomError(vault, "InvalidAddress");
  });

  it("invalidates stale signatures and queued effects at rotation while new signers operate", async function () {
    await depositor.sendTransaction({ to: vault, value: 20n });
    const d = await deadline();
    const staleWithdraw = { asset: ethers.ZeroAddress, to: depositor.address, amount: 1, nonce: 91, deadline: d, immediate: false };
    const staleWithdrawSig = await sign(authorizer, "Withdraw", Withdraw, staleWithdraw);
    const staleRecover = { asset: ethers.ZeroAddress, amount: 1, nonce: 92, deadline: d };
    const staleRecoverSig = await sign(recovery, "Recover", Recover, staleRecover);
    const stalePause = { paused: true, nonce: 1, deadline: d };
    const stalePauseSig = await sign(authorizer, "SetPaused", Pause, stalePause);
    const staleTrust = { account: depositor.address, trusted: true, nonce: 1, deadline: d };
    const staleTrustA = await sign(authorizer, "SetTrusted", SetTrusted, staleTrust);
    const staleTrustR = await sign(recovery, "SetTrusted", SetTrusted, staleTrust);

    const queued = { asset: ethers.ZeroAddress, to: recipient.address, amount: 2, nonce: 90, deadline: d, immediate: false };
    const queuedSig = await sign(authorizer, "Withdraw", Withdraw, queued);
    const requestId = await vault.scheduleWithdrawal.staticCall(queued.asset, queued.to, queued.amount, queued.nonce, d, queuedSig);
    await vault.scheduleWithdrawal(queued.asset, queued.to, queued.amount, queued.nonce, d, queuedSig);
    const pendingTrust = { account: recipient.address, trusted: true, nonce: 1, deadline: d };
    await vault.scheduleTrust(recipient, 1, d, await sign(authorizer, "SetTrusted", SetTrusted, pendingTrust),
      await sign(recovery, "SetTrusted", SetTrusted, pendingTrust));

    const rotation = { authorizer: nextAuthorizer.address, recoveryAuthorizer: nextRecovery.address, nonce: 1, deadline: d };
    await vault.scheduleRotation(rotation.authorizer, rotation.recoveryAuthorizer, 1, d,
      await sign(authorizer, "RotateAuthorities", Rotate, rotation), await sign(recovery, "RotateAuthorities", Rotate, rotation));
    await ethers.provider.send("evm_increaseTime", [delay]); await ethers.provider.send("evm_mine");
    await vault.activateRotation(1);
    expect(await vault.VERSION()).to.equal("1:1");

    await expect(vault.scheduleWithdrawal(staleWithdraw.asset, staleWithdraw.to, staleWithdraw.amount, staleWithdraw.nonce, d, staleWithdrawSig)).to.be.revertedWithCustomError(vault, "InvalidSignature");
    await expect(vault.recover(staleRecover.asset, staleRecover.amount, staleRecover.nonce, d, staleRecoverSig)).to.be.revertedWithCustomError(vault, "InvalidSignature");
    await expect(vault.setPaused(true, false, 1, d, stalePauseSig, "0x")).to.be.revertedWithCustomError(vault, "InvalidSignature");
    await expect(vault.scheduleTrust(staleTrust.account, 1, d, staleTrustA, staleTrustR)).to.be.revertedWithCustomError(vault, "InvalidSignature");
    await expect(vault.executeWithdrawal(requestId)).to.be.revertedWithCustomError(vault, "RequestMissing");
    await expect(vault.activateTrust(recipient, 1)).to.be.revertedWithCustomError(vault, "TrustChangeMissing");

    domain.version = await vault.VERSION();
    const freshSig = await sign(nextAuthorizer, "Withdraw", Withdraw, staleWithdraw);
    await expect(vault.scheduleWithdrawal(staleWithdraw.asset, staleWithdraw.to, staleWithdraw.amount, staleWithdraw.nonce, d, freshSig)).to.emit(vault, "WithdrawalScheduled");
    const freshRecover = { asset: ethers.ZeroAddress, amount: 1, nonce: 92, deadline: d };
    await expect(vault.recover(freshRecover.asset, freshRecover.amount, freshRecover.nonce, d,
      await sign(nextRecovery, "Recover", Recover, freshRecover))).to.emit(vault, "RecoveryExecuted");
  });

  it("invalidates active trusted recipients in O(1) when authorities rotate", async function () {
    let d = await deadline();
    const trust = { account: depositor.address, trusted: true, nonce: 1, deadline: d };
    await vault.scheduleTrust(depositor, 1, d, await sign(authorizer, "SetTrusted", SetTrusted, trust),
      await sign(recovery, "SetTrusted", SetTrusted, trust));
    await ethers.provider.send("evm_increaseTime", [delay]); await ethers.provider.send("evm_mine");
    await vault.activateTrust(depositor, 1);
    expect(await vault.trusted(depositor)).to.equal(true);

    d = await deadline();
    const rotation = { authorizer: nextAuthorizer.address, recoveryAuthorizer: nextRecovery.address, nonce: 1, deadline: d };
    await vault.scheduleRotation(rotation.authorizer, rotation.recoveryAuthorizer, 1, d,
      await sign(authorizer, "RotateAuthorities", Rotate, rotation), await sign(recovery, "RotateAuthorities", Rotate, rotation));
    await ethers.provider.send("evm_increaseTime", [delay]); await ethers.provider.send("evm_mine");
    await vault.activateRotation(1);
    expect(await vault.trusted(depositor)).to.equal(false);
  });

  it("fuzzes net-received accounting across fee-token deposit amounts", async function () {
    const fee = await ethers.deployContract("FeeToken");
    let expected = 0n;
    // Deterministic edge-heavy corpus: sub-fee-unit, decimal boundaries, and pseudo-random values.
    const amounts = [0n, 1n, 9n, 10n, 11n, 99n, 100n, 101n, 2n ** 32n - 1n];
    let x = 0x12345678n;
    for (let i = 0; i < 24; i++) {
      x = (1103515245n * x + 12345n) % (2n ** 31n);
      amounts.push(x + 1n);
    }
    const total = amounts.reduce((a, b) => a + b, 0n);
    await fee.mint(depositor, total); await fee.connect(depositor).approve(vault, total);
    for (const amount of amounts) {
      const received = amount - amount / 10n;
      expected += received;
      await expect(vault.connect(depositor).depositToken(fee, amount))
        .to.emit(vault, "TokenDeposited").withArgs(depositor.address, await fee.getAddress(), received);
      expect(await fee.balanceOf(vault)).to.equal(expected);
    }
  });
});
