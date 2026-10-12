const { expect } = require("chai");
const { ethers } = require("hardhat");
const { createManifest } = require("../scripts/deployment-manifest");
const { lifecycle } = require("../scripts/safumode-lifecycle");

const RPC = "http://127.0.0.1:8545";
const trustTypes = { SetTrusted: [
  { name: "account", type: "address" }, { name: "trusted", type: "bool" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
] };
const withdrawTypes = { Withdraw: [
  { name: "asset", type: "address" }, { name: "to", type: "address" },
  { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" }, { name: "immediate", type: "bool" },
] };
const rotateTypes = { RotateAuthorities: [
  { name: "authorizer", type: "address" }, { name: "recoveryAuthorizer", type: "address" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
] };

async function fixture() {
  const [relayer, authorizer, recovery, recipient, account, nextAuthorizer, nextRecovery] = await ethers.getSigners();
  const delay = 60;
  const vault = await ethers.deployContract("AuthorizationVault", [authorizer.address, recovery.address, recipient.address, delay]);
  await vault.waitForDeployment();
  const manifest = await createManifest(vault, { authorizer: authorizer.address, recoveryAuthorizer: recovery.address, recoveryRecipient: recipient.address, delay }, ethers.provider);
  const domain = { name: "Authorization Vault Prototype", version: await vault.VERSION(), chainId: 31337, verifyingContract: await vault.getAddress() };
  const deadline = (await ethers.provider.getBlock("latest")).timestamp + 10000;
  return { relayer, authorizer, recovery, account, nextAuthorizer, nextRecovery, vault, manifest, domain, deadline, delay };
}
async function mature(seconds = 61) { await ethers.provider.send("evm_increaseTime", [seconds]); await ethers.provider.send("evm_mine", []); }
function options(f, broadcast = false) { return { rpcUrl: RPC, broadcast, relayerAddress: f.relayer.address }; }

async function scheduleTrust(f) {
  const value = { account: f.account.address, trusted: true, nonce: 1, deadline: f.deadline };
  await f.vault.scheduleTrust(value.account, value.nonce, value.deadline,
    await f.authorizer.signTypedData(f.domain, trustTypes, value), await f.recovery.signTypedData(f.domain, trustTypes, value));
}

describe("SAFUMODE unsigned lifecycle CLI library e2e", function () {
  it("dry-runs activateTrust with staticCall without changing state, then explicitly broadcasts", async function () {
    const f = await fixture(); await scheduleTrust(f); await mature();
    const input = { account: f.account.address, nonce: "1" };
    expect(await lifecycle(f.manifest, "activate-trust", input, ethers.provider, null, options(f))).to.include({ dryRun: true, method: "activateTrust" });
    expect(await f.vault.trusted(f.account.address)).to.equal(false);
    const sent = await lifecycle(f.manifest, "activate-trust", input, ethers.provider, f.relayer, options(f, true));
    expect(sent.dryRun).to.equal(false); expect(sent.transactionHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(await f.vault.trusted(f.account.address)).to.equal(true);
  });

  it("dry-runs and broadcasts executeWithdrawal against the exact live request", async function () {
    const f = await fixture();
    await f.relayer.sendTransaction({ to: await f.vault.getAddress(), value: 100n });
    const value = { asset: ethers.ZeroAddress, to: f.account.address, amount: 40, nonce: 7, deadline: f.deadline, immediate: false };
    const signature = await f.authorizer.signTypedData(f.domain, withdrawTypes, value);
    const requestId = await f.vault.scheduleWithdrawal.staticCall(value.asset, value.to, value.amount, value.nonce, value.deadline, signature);
    await f.vault.scheduleWithdrawal(value.asset, value.to, value.amount, value.nonce, value.deadline, signature); await mature();
    expect((await lifecycle(f.manifest, "execute-withdrawal", { requestId }, ethers.provider, null, options(f))).dryRun).to.equal(true);
    expect((await f.vault.requests(requestId)).executed).to.equal(false);
    await lifecycle(f.manifest, "execute-withdrawal", { requestId }, ethers.provider, f.relayer, options(f, true));
    expect((await f.vault.requests(requestId)).executed).to.equal(true);
  });

  it("dry-runs and broadcasts activateRotation and rejects stale state", async function () {
    const f = await fixture();
    const value = { authorizer: f.nextAuthorizer.address, recoveryAuthorizer: f.nextRecovery.address, nonce: 1, deadline: f.deadline };
    await f.vault.scheduleRotation(value.authorizer, value.recoveryAuthorizer, value.nonce, value.deadline,
      await f.authorizer.signTypedData(f.domain, rotateTypes, value), await f.recovery.signTypedData(f.domain, rotateTypes, value)); await mature();
    expect((await lifecycle(f.manifest, "activate-rotation", { nonce: "1" }, ethers.provider, null, options(f))).dryRun).to.equal(true);
    await lifecycle(f.manifest, "activate-rotation", { nonce: "1" }, ethers.provider, f.relayer, options(f, true));
    expect(await f.vault.authorizer()).to.equal(f.nextAuthorizer.address);
    await expect(lifecycle(f.manifest, "activate-rotation", { nonce: "1" }, ethers.provider, null, options(f))).to.be.rejectedWith(/pending state/);
  });

  it("fails closed for non-loopback RPC, early state, manifest mismatch, and relayer mismatch", async function () {
    const f = await fixture(); await scheduleTrust(f);
    const input = { account: f.account.address, nonce: "1" };
    await expect(lifecycle(f.manifest, "activate-trust", input, ethers.provider, null, { rpcUrl: "https://rpc.example" })).to.be.rejectedWith(/loopback/);
    await expect(lifecycle(f.manifest, "activate-trust", input, ethers.provider, null, options(f))).to.be.rejectedWith(/too early/);
    await mature();
    await expect(lifecycle(f.manifest, "activate-trust", input, ethers.provider, f.authorizer, options(f, true))).to.be.rejectedWith(/does not match explicit/);
    await expect(lifecycle({ ...f.manifest, runtimeCodeHash: `0x${"00".repeat(32)}` }, "activate-trust", input, ethers.provider, null, options(f))).to.be.rejectedWith(/runtime code hash mismatch/);
  });
});
