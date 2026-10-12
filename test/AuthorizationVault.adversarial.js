const { expect } = require("chai");
const { ethers } = require("hardhat");

const Withdraw = [
  { name: "asset", type: "address" }, { name: "to", type: "address" },
  { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" }, { name: "immediate", type: "bool" },
];
const Cancel = [
  { name: "requestId", type: "bytes32" }, { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
];
const Recover = [
  { name: "asset", type: "address" }, { name: "amount", type: "uint256" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
];

describe("AuthorizationVault adversarial", function () {
  let vault, authorizer, recovery, recipient, other, domain;
  const delay = 3600;

  beforeEach(async function () {
    [, authorizer, recovery, recipient, other] = await ethers.getSigners();
    vault = await ethers.deployContract("AuthorizationVault", [authorizer, recovery, recipient, delay]);
    domain = { name: "Authorization Vault Prototype", version: await vault.VERSION(), chainId: 31337, verifyingContract: await vault.getAddress() };
  });
  async function now() { return (await ethers.provider.getBlock("latest")).timestamp; }
  async function sign(signer, type, fields, value, signingDomain = domain) {
    return signer.signTypedData(signingDomain, { [type]: fields }, value);
  }
  async function queue(nonce = 1) {
    const value = { asset: ethers.ZeroAddress, to: other.address, amount: 1, nonce, deadline: (await now()) + 10000, immediate: false };
    const sig = await sign(authorizer, "Withdraw", Withdraw, value);
    const id = await vault.scheduleWithdrawal.staticCall(value.asset, value.to, value.amount, value.nonce, value.deadline, sig);
    await vault.scheduleWithdrawal(value.asset, value.to, value.amount, value.nonce, value.deadline, sig);
    return { id, value };
  }

  it("binds fields/domain and rejects wrong signer and signature length", async function () {
    const value = { asset: ethers.ZeroAddress, to: other.address, amount: 1, nonce: 10, deadline: (await now()) + 1000, immediate: false };
    const variants = [
      [await sign(authorizer, "Withdraw", Withdraw, value, { ...domain, chainId: 31338 }), value],
      [await sign(authorizer, "Withdraw", Withdraw, value, { ...domain, verifyingContract: other.address }), value],
      [await sign(recovery, "Withdraw", Withdraw, value), value],
      [await sign(authorizer, "Withdraw", Withdraw, value), { ...value, amount: 2 }],
    ];
    for (const [sig, call] of variants) {
      await expect(vault.scheduleWithdrawal(call.asset, call.to, call.amount, call.nonce, call.deadline, sig))
        .to.be.revertedWithCustomError(vault, "InvalidSignature");
    }
    await expect(vault.scheduleWithdrawal(value.asset, value.to, value.amount, value.nonce, value.deadline, "0x12"))
      .to.be.revertedWithCustomError(vault, "InvalidSignature");
  });

  it("rejects high-s malleability and replay", async function () {
    const value = { asset: ethers.ZeroAddress, to: other.address, amount: 1, nonce: 21, deadline: (await now()) + 1000, immediate: false };
    const sig = await sign(authorizer, "Withdraw", Withdraw, value);
    const parsed = ethers.Signature.from(sig);
    const n = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const high = ethers.concat([parsed.r, ethers.toBeHex(n - BigInt(parsed.s), 32), parsed.v === 27 ? "0x1c" : "0x1b"]);
    await expect(vault.scheduleWithdrawal(value.asset, value.to, value.amount, value.nonce, value.deadline, high))
      .to.be.revertedWithCustomError(vault, "InvalidSignature");
    await vault.scheduleWithdrawal(value.asset, value.to, value.amount, value.nonce, value.deadline, sig);
    await expect(vault.scheduleWithdrawal(value.asset, value.to, value.amount, value.nonce, value.deadline, sig))
      .to.be.revertedWithCustomError(vault, "NonceUsed");
  });

  it("treats deadline and timelock as inclusive exact boundaries", async function () {
    const { id } = await queue();
    const executableAt = Number((await vault.requests(id)).executableAt);
    await ethers.provider.send("evm_setNextBlockTimestamp", [executableAt - 1]);
    await expect(vault.executeWithdrawal(id)).to.be.revertedWithCustomError(vault, "TooEarly");
    await ethers.provider.send("hardhat_setBalance", [await vault.getAddress(), "0x1"]);
    await ethers.provider.send("evm_setNextBlockTimestamp", [executableAt]);
    await expect(vault.executeWithdrawal(id)).to.emit(vault, "WithdrawalExecuted");
    const d = (await now()) + 5;
    const value = { asset: ethers.ZeroAddress, to: other.address, amount: 0, nonce: 2, deadline: d, immediate: false };
    const sig = await sign(authorizer, "Withdraw", Withdraw, value);
    await ethers.provider.send("evm_setNextBlockTimestamp", [d]);
    await expect(vault.scheduleWithdrawal(value.asset, value.to, value.amount, value.nonce, d, sig)).to.emit(vault, "WithdrawalScheduled");
  });

  it("defines cancellation ordering at maturity and after execution", async function () {
    const { id, value } = await queue(31);
    const at = Number((await vault.requests(id)).executableAt);
    const cancel = { requestId: id, nonce: 32, deadline: value.deadline };
    await ethers.provider.send("evm_setNextBlockTimestamp", [at]);
    await vault.cancelWithdrawal(id, true, cancel.nonce, cancel.deadline, await sign(recovery, "Cancel", Cancel, cancel));
    await expect(vault.executeWithdrawal(id)).to.be.revertedWithCustomError(vault, "RequestMissing");
    const second = await queue(33);
    await ethers.provider.send("hardhat_setBalance", [await vault.getAddress(), "0x1"]);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number((await vault.requests(second.id)).executableAt)]);
    await vault.executeWithdrawal(second.id);
    const c2 = { requestId: second.id, nonce: 34, deadline: second.value.deadline };
    await expect(vault.cancelWithdrawal(second.id, true, c2.nonce, c2.deadline, await sign(recovery, "Cancel", Cancel, c2)))
      .to.be.revertedWithCustomError(vault, "RequestMissing");
    expect(await vault.recoveryNonceUsed(34)).to.equal(false);
  });

  it("normalizes false, short, non-canonical bool, and EOA token failures", async function () {
    for (const name of ["FalseToken", "ShortReturnToken", "MalformedReturnToken"]) {
      const token = await ethers.deployContract(name);
      await expect(vault.depositToken(token, 1)).to.be.revertedWithCustomError(vault, "TransferFailed");
    }
    await expect(vault.depositToken(other, 1)).to.be.revertedWithCustomError(vault, "TransferFailed");
  });

  it("reports fee-token deposits by the net amount actually received", async function () {
    const fee = await ethers.deployContract("FeeToken");
    await fee.mint(other, 100); await fee.connect(other).approve(vault, 100);
    await expect(vault.connect(other).depositToken(fee, 100)).to.emit(vault, "TokenDeposited").withArgs(other, fee, 90);
    expect(await fee.balanceOf(vault)).to.equal(90);
  });

  it("blocks token callback reentrancy without reverting outer recovery", async function () {
    const token = await ethers.deployContract("ReentrantToken");
    await token.mint(vault, 2);
    const d = (await now()) + 1000;
    const inner = { asset: await token.getAddress(), amount: 1, nonce: 42, deadline: d };
    const innerSig = await sign(recovery, "Recover", Recover, inner);
    await token.configureCallback(vault, vault.interface.encodeFunctionData("recover", [inner.asset, inner.amount, inner.nonce, inner.deadline, innerSig]));
    const outer = { ...inner, nonce: 41 };
    await vault.recover(outer.asset, outer.amount, outer.nonce, outer.deadline, await sign(recovery, "Recover", Recover, outer));
    expect(await token.callbackAttempted()).to.equal(true);
    expect(await token.callbackSucceeded()).to.equal(false);
    expect(await vault.recoveryNonceUsed(41)).to.equal(true);
    expect(await vault.recoveryNonceUsed(42)).to.equal(false);
  });
});
