const { expect } = require("chai");
const { ethers } = require("hardhat");
const { prepare, relay } = require("../scripts/safumode-tx");
const { loadBuildIdentity } = require("../scripts/deployment-manifest");

describe("SAFUMODE unpause relay signature ordering", function () {
  let vault, manifest, authorizer, recovery, recoveryRecipient, relayer;

  beforeEach(async function () {
    [, authorizer, recovery, recoveryRecipient, relayer] = await ethers.getSigners();
    vault = await ethers.deployContract("AuthorizationVault", [
      authorizer.address,
      recovery.address,
      recoveryRecipient.address,
      60,
    ]);
    const vaultAddress = await vault.getAddress();
    const code = await ethers.provider.getCode(vaultAddress);
    manifest = {
      schema: "safumode-local-deployment-v1",
      environment: "hardhat-local-only",
      chainId: "31337",
      address: vaultAddress,
      runtimeCodeHash: ethers.keccak256(code),
      constructor: {
        authorizer: authorizer.address,
        recoveryAuthorizer: recovery.address,
        recoveryRecipient: recoveryRecipient.address,
        delay: "60",
      },
      build: loadBuildIdentity(),
    };
  });

  async function signedPause(paused, byRecovery, nonce) {
    const latest = await ethers.provider.getBlock("latest");
    const bundle = prepare(manifest, "pause", {
      paused,
      byRecovery,
      nonce,
      deadline: String(latest.timestamp + 1000),
    });
    const signatures = {};
    for (const role of Object.keys(bundle.expectedSigners)) {
      const signer = role === "authorizer" ? authorizer : recovery;
      signatures[role] = await signer.signTypedData(bundle.domain, bundle.types, bundle.message);
    }
    return { bundle, signatures };
  }

  async function broadcast(prepared) {
    return relay(
      prepared.bundle,
      manifest,
      prepared.signatures,
      ethers.provider,
      relayer,
      {
        rpcUrl: "http://127.0.0.1",
        relayerAddress: relayer.address,
      }
    );
  }

  it("unpauses with authorizer first even when byRecovery metadata remains true", async function () {
    await broadcast(await signedPause(true, true, "1"));
    expect(await vault.paused()).to.equal(true);

    // `byRecovery` is semantically irrelevant for unpause: the contract always
    // requires authorizer as signature one and recovery as signature two.
    await broadcast(await signedPause(false, true, "2"));

    expect(await vault.paused()).to.equal(false);
    expect(await vault.controlNonce()).to.equal(2n);
  });
});
