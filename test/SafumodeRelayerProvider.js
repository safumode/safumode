const { expect } = require("chai");
const { ethers } = require("hardhat");
const { createManifest } = require("../scripts/deployment-manifest");
const { prepare, relay } = require("../scripts/safumode-tx");
const { lifecycle } = require("../scripts/safumode-lifecycle");

const RPC = "http://127.0.0.1:8545";

describe("SAFUMODE relayer provider binding", function () {
  let authorizer, recovery, recipient, account, relayer, vault, manifest;

  beforeEach(async function () {
    [relayer, authorizer, recovery, recipient, account] = await ethers.getSigners();
    vault = await ethers.deployContract("AuthorizationVault", [
      authorizer.address, recovery.address, recipient.address, 60,
    ]);
    await vault.waitForDeployment();
    manifest = await createManifest(vault, {
      authorizer: authorizer.address,
      recoveryAuthorizer: recovery.address,
      recoveryRecipient: recipient.address,
      delay: 60,
    }, ethers.provider);
  });

  function signerOnDistinctProvider() {
    const otherProvider = new ethers.JsonRpcProvider("http://127.0.0.1:1");
    const sameAddressSigner = new ethers.JsonRpcSigner(otherProvider, relayer.address);
    let broadcasts = 0;
    sameAddressSigner.sendTransaction = async () => {
      broadcasts += 1;
      throw new Error("broadcast attempted");
    };
    return { sameAddressSigner, broadcasts: () => broadcasts };
  }

  it("rejects a same-address signed-relay signer on a distinct provider before broadcast", async function () {
    const deadline = String((await ethers.provider.getBlock("latest")).timestamp + 1000);
    const bundle = prepare(manifest, "schedule", {
      asset: ethers.ZeroAddress, to: account.address, amount: "1", nonce: "1", deadline,
    });
    const signatures = {
      authorizer: await authorizer.signTypedData(bundle.domain, bundle.types, bundle.message),
    };
    const other = signerOnDistinctProvider();

    await expect(relay(bundle, manifest, signatures, ethers.provider, other.sameAddressSigner, {
      rpcUrl: RPC, relayerAddress: relayer.address,
    })).to.be.rejectedWith(/relayer provider does not match checked provider/);
    expect(other.broadcasts()).to.equal(0);
    expect(await vault.authorizerNonceUsed(1)).to.equal(false);
  });

  it("rejects a same-address lifecycle signer on a distinct provider before broadcast", async function () {
    const domain = {
      name: "Authorization Vault Prototype", version: await vault.VERSION(),
      chainId: 31337, verifyingContract: await vault.getAddress(),
    };
    const types = { SetTrusted: [
      { name: "account", type: "address" }, { name: "trusted", type: "bool" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] };
    const value = {
      account: account.address, trusted: true, nonce: 1,
      deadline: (await ethers.provider.getBlock("latest")).timestamp + 1000,
    };
    await vault.scheduleTrust(value.account, value.nonce, value.deadline,
      await authorizer.signTypedData(domain, types, value),
      await recovery.signTypedData(domain, types, value));
    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine", []);
    const other = signerOnDistinctProvider();

    await expect(lifecycle(manifest, "activate-trust", { account: account.address, nonce: "1" },
      ethers.provider, other.sameAddressSigner, {
        rpcUrl: RPC, broadcast: true, relayerAddress: relayer.address,
      })).to.be.rejectedWith(/relayer provider does not match checked provider/);
    expect(other.broadcasts()).to.equal(0);
    expect(await vault.trusted(account.address)).to.equal(false);
  });
});
