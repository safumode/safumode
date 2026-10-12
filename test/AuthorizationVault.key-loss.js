const { expect } = require("chai");
const { ethers } = require("hardhat");

// Fixed, publicly visible development keys. They are deliberately local-only and
// must never hold real assets.
const LOCAL_KEYS = {
  authorizer: "0x1000000000000000000000000000000000000000000000000000000000000001",
  recovery: "0x2000000000000000000000000000000000000000000000000000000000000002",
  nextAuthorizer: "0x3000000000000000000000000000000000000000000000000000000000000003",
  nextRecovery: "0x4000000000000000000000000000000000000000000000000000000000000004",
};

const TYPES = {
  Withdraw: [
    { name: "asset", type: "address" }, { name: "to", type: "address" },
    { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }, { name: "immediate", type: "bool" },
  ],
  Recover: [
    { name: "asset", type: "address" }, { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
  SetPaused: [
    { name: "paused", type: "bool" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  RotateAuthorities: [
    { name: "authorizer", type: "address" }, { name: "recoveryAuthorizer", type: "address" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
};

describe("AuthorizationVault deterministic key-loss matrix", function () {
  const delay = 3600;
  let deployer, recoveryRecipient, alternateRecipient;
  let authorizer, recovery, nextAuthorizer, nextRecovery;
  let vault, token, domain;

  beforeEach(async function () {
    [deployer, recoveryRecipient, alternateRecipient] = await ethers.getSigners();
    authorizer = new ethers.Wallet(LOCAL_KEYS.authorizer);
    recovery = new ethers.Wallet(LOCAL_KEYS.recovery);
    nextAuthorizer = new ethers.Wallet(LOCAL_KEYS.nextAuthorizer);
    nextRecovery = new ethers.Wallet(LOCAL_KEYS.nextRecovery);

    vault = await ethers.deployContract("AuthorizationVault", [
      authorizer.address, recovery.address, recoveryRecipient.address, delay,
    ]);
    token = await ethers.deployContract("MockToken");
    domain = {
      name: "Authorization Vault Prototype",
      version: await vault.VERSION(),
      chainId: 31337,
      verifyingContract: await vault.getAddress(),
    };
  });

  async function deadline() {
    return (await ethers.provider.getBlock("latest")).timestamp + 86_400;
  }

  async function sign(signer, type, value) {
    return signer.signTypedData(domain, { [type]: TYPES[type] }, value);
  }

  async function fund(nativeAmount = 20n, tokenAmount = 20n) {
    await deployer.sendTransaction({ to: vault, value: nativeAmount });
    await token.mint(deployer, tokenAmount);
    await token.approve(vault, tokenAmount);
    await vault.depositToken(token, tokenAmount);
  }

  async function advanceDelay() {
    await ethers.provider.send("evm_increaseTime", [delay]);
    await ethers.provider.send("evm_mine");
  }

  async function expectSingleKeyRotationRejected(onlySigner) {
    const d = await deadline();
    const rotation = {
      authorizer: nextAuthorizer.address,
      recoveryAuthorizer: nextRecovery.address,
      nonce: 1,
      deadline: d,
    };
    const oneSignature = await sign(onlySigner, "RotateAuthorities", rotation);
    await expect(vault.scheduleRotation(
      rotation.authorizer, rotation.recoveryAuthorizer, rotation.nonce, d,
      oneSignature, oneSignature,
    )).to.be.revertedWithCustomError(vault, "InvalidSignature");
    expect(await vault.rotationNonce()).to.equal(0n);
    expect((await vault.pendingRotation()).executableAt).to.equal(0n);
  }

  it("does not permit rotation or role substitution with only the authorizer key", async function () {
    await expectSingleKeyRotationRejected(authorizer);

    const d = await deadline();
    const recover = { asset: ethers.ZeroAddress, amount: 1n, nonce: 10n, deadline: d };
    await expect(vault.recover(
      recover.asset, recover.amount, recover.nonce, d,
      await sign(authorizer, "Recover", recover),
    )).to.be.revertedWithCustomError(vault, "InvalidSignature");
  });

  it("does not permit rotation or withdrawal-role substitution with only the recovery key", async function () {
    await expectSingleKeyRotationRejected(recovery);

    const d = await deadline();
    const withdrawal = {
      asset: ethers.ZeroAddress, to: alternateRecipient.address, amount: 1n,
      nonce: 11n, deadline: d, immediate: false,
    };
    await expect(vault.scheduleWithdrawal(
      withdrawal.asset, withdrawal.to, withdrawal.amount, withdrawal.nonce, d,
      await sign(recovery, "Withdraw", withdrawal),
    )).to.be.revertedWithCustomError(vault, "InvalidSignature");
  });

  it("with authorizer lost, recovery drains native and ERC20 only to the immutable recipient", async function () {
    await fund();
    const fixedBeforeNative = await ethers.provider.getBalance(recoveryRecipient.address);
    const alternateBeforeNative = await ethers.provider.getBalance(alternateRecipient.address);
    const d = await deadline();

    const nativeRecovery = { asset: ethers.ZeroAddress, amount: 7n, nonce: 21n, deadline: d };
    await vault.recover(nativeRecovery.asset, nativeRecovery.amount, nativeRecovery.nonce, d,
      await sign(recovery, "Recover", nativeRecovery));
    const tokenRecovery = { asset: await token.getAddress(), amount: 9n, nonce: 22n, deadline: d };
    await vault.recover(tokenRecovery.asset, tokenRecovery.amount, tokenRecovery.nonce, d,
      await sign(recovery, "Recover", tokenRecovery));

    expect(await ethers.provider.getBalance(recoveryRecipient.address)).to.equal(fixedBeforeNative + 7n);
    expect(await token.balanceOf(recoveryRecipient.address)).to.equal(9n);
    expect(await ethers.provider.getBalance(alternateRecipient.address)).to.equal(alternateBeforeNative);
    expect(await token.balanceOf(alternateRecipient.address)).to.equal(0n);

    // Recover has no destination field. A recovery-key signature over a Withdraw
    // payload naming another recipient cannot be repurposed as a recovery permit.
    const forgedDestination = {
      asset: ethers.ZeroAddress, to: alternateRecipient.address, amount: 1n,
      nonce: 23n, deadline: d, immediate: false,
    };
    await expect(vault.recover(ethers.ZeroAddress, 1n, 23n, d,
      await sign(recovery, "Withdraw", forgedDestination)))
      .to.be.revertedWithCustomError(vault, "InvalidSignature");
    expect(await vault.recoveryRecipient()).to.equal(recoveryRecipient.address);
  });

  it("with recovery lost, authorizer timelocks native/ERC20 to fixed or arbitrary recipients but cannot recover", async function () {
    await fund();
    const d = await deadline();
    const native = {
      asset: ethers.ZeroAddress, to: recoveryRecipient.address, amount: 6n,
      nonce: 31n, deadline: d, immediate: false,
    };
    const erc20 = {
      asset: await token.getAddress(), to: alternateRecipient.address, amount: 8n,
      nonce: 32n, deadline: d, immediate: false,
    };
    const nativeId = await vault.scheduleWithdrawal.staticCall(
      native.asset, native.to, native.amount, native.nonce, d, await sign(authorizer, "Withdraw", native));
    await vault.scheduleWithdrawal(native.asset, native.to, native.amount, native.nonce, d,
      await sign(authorizer, "Withdraw", native));
    const tokenId = await vault.scheduleWithdrawal.staticCall(
      erc20.asset, erc20.to, erc20.amount, erc20.nonce, d, await sign(authorizer, "Withdraw", erc20));
    await vault.scheduleWithdrawal(erc20.asset, erc20.to, erc20.amount, erc20.nonce, d,
      await sign(authorizer, "Withdraw", erc20));

    await expect(vault.executeWithdrawal(nativeId)).to.be.revertedWithCustomError(vault, "TooEarly");
    await advanceDelay();
    const fixedBefore = await ethers.provider.getBalance(recoveryRecipient.address);
    await vault.executeWithdrawal(nativeId);
    await vault.executeWithdrawal(tokenId);
    expect(await ethers.provider.getBalance(recoveryRecipient.address)).to.equal(fixedBefore + 6n);
    expect(await token.balanceOf(alternateRecipient.address)).to.equal(8n);

    const unilateralRecover = { asset: await token.getAddress(), amount: 1n, nonce: 33n, deadline: d };
    await expect(vault.recover(unilateralRecover.asset, unilateralRecover.amount,
      unilateralRecover.nonce, d, await sign(authorizer, "Recover", unilateralRecover)))
      .to.be.revertedWithCustomError(vault, "InvalidSignature");
  });

  for (const scenario of [
    { label: "authorizer lost", survivor: "recovery" },
    { label: "recovery lost", survivor: "authorizer" },
  ]) {
    it(`when paused with ${scenario.label}, blocks outflows and the surviving key cannot resume`, async function () {
      await fund();
      const survivor = scenario.survivor === "recovery" ? recovery : authorizer;
      let d = await deadline();
      const pause = { paused: true, nonce: 1n, deadline: d };
      await vault.setPaused(true, scenario.survivor === "recovery", 1n, d,
        await sign(survivor, "SetPaused", pause), "0x");
      expect(await vault.paused()).to.equal(true);

      if (scenario.survivor === "recovery") {
        for (const [asset, nonce] of [[ethers.ZeroAddress, 41n], [await token.getAddress(), 42n]]) {
          const recoveryValue = { asset, amount: 1n, nonce, deadline: d };
          await expect(vault.recover(asset, recoveryValue.amount, nonce, d,
            await sign(recovery, "Recover", recoveryValue)))
            .to.be.revertedWithCustomError(vault, "Paused");
        }
      } else {
        for (const [asset, nonce] of [[ethers.ZeroAddress, 43n], [await token.getAddress(), 44n]]) {
          const withdrawal = {
            asset, to: alternateRecipient.address, amount: 1n,
            nonce, deadline: d, immediate: false,
          };
          await expect(vault.scheduleWithdrawal(asset, withdrawal.to, withdrawal.amount,
            nonce, d, await sign(authorizer, "Withdraw", withdrawal)))
            .to.be.revertedWithCustomError(vault, "Paused");
        }
      }

      d = await deadline();
      const resume = { paused: false, nonce: 2n, deadline: d };
      const oneSignature = await sign(survivor, "SetPaused", resume);
      await expect(vault.setPaused(false, false, 2n, d, oneSignature, oneSignature))
        .to.be.revertedWithCustomError(vault, "InvalidSignature");
      expect(await vault.paused()).to.equal(true);
      expect(await vault.controlNonce()).to.equal(1n);
      expect(await ethers.provider.getBalance(vault)).to.equal(20n);
      expect(await token.balanceOf(vault)).to.equal(20n);
    });
  }
});
