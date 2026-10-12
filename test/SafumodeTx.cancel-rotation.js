const { expect } = require("chai");
const { ethers } = require("hardhat");
const { prepare, relay } = require("../scripts/safumode-tx");
const { PREPARE_ACTIONS } = require("../scripts/safumode-cli");
const { loadBuildIdentity } = require("../scripts/deployment-manifest");

describe("SAFUMODE offline rotation veto", function () {
  let vault, manifest, authorizer, recovery, recipient, relayer, nextAuthorizer, nextRecovery;

  beforeEach(async function () {
    [, authorizer, recovery, recipient, relayer, nextAuthorizer, nextRecovery] = await ethers.getSigners();
    vault = await ethers.deployContract("AuthorizationVault", [authorizer.address, recovery.address, recipient.address, 60]);
    const address = await vault.getAddress();
    manifest = {
      schema: "safumode-local-deployment-v1", environment: "hardhat-local-only", chainId: "31337", address,
      runtimeCodeHash: ethers.keccak256(await ethers.provider.getCode(address)),
      constructor: { authorizer: authorizer.address, recoveryAuthorizer: recovery.address, recoveryRecipient: recipient.address, delay: "60" },
      build: loadBuildIdentity(),
    };
  });

  async function deadline() { return String((await ethers.provider.getBlock("latest")).timestamp + 1000); }
  async function signed(action, input) {
    const bundle = prepare(manifest, action, input);
    const signatures = {};
    for (const role of Object.keys(bundle.expectedSigners)) {
      signatures[role] = await (role === "authorizer" ? authorizer : recovery).signTypedData(bundle.domain, bundle.types, bundle.message);
    }
    return { bundle, signatures };
  }
  async function broadcast(prepared) {
    return relay(prepared.bundle, manifest, prepared.signatures, ethers.provider, relayer,
      { rpcUrl: "http://127.0.0.1", relayerAddress: relayer.address });
  }
  async function schedule(nonce) {
    await broadcast(await signed("rotate", {
      authorizer: nextAuthorizer.address, recoveryAuthorizer: nextRecovery.address,
      nonce: String(nonce), deadline: await deadline(),
    }));
  }

  for (const [label, byRecovery, role] of [["authorizer", false, "authorizer"], ["recovery authority", true, "recoveryAuthorizer"]]) {
    it(`prepares and relays a ${label} veto`, async function () {
      await schedule(1);
      const prepared = await signed("cancel-rotation", { byRecovery, nonce: "1", deadline: await deadline() });

      expect(prepared.bundle.primaryType).to.equal("CancelRotation");
      expect(prepared.bundle.types).to.deep.equal({ CancelRotation: [
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ] });
      expect(prepared.bundle.message).to.not.have.property("byRecovery");
      expect(prepared.bundle.metadata).to.deep.equal({ byRecovery });
      expect(prepared.bundle.expectedSigners).to.have.all.keys(role);

      const result = await broadcast(prepared);
      const receipt = await ethers.provider.getTransactionReceipt(result.transactionHash);
      const event = receipt.logs.map((log) => { try { return vault.interface.parseLog(log); } catch (_) { return null; } })
        .find((log) => log && log.name === "RotationCancelled");
      expect(event.args).to.deep.equal([1n, byRecovery ? recovery.address : authorizer.address]);
      expect((await vault.pendingRotation()).executableAt).to.equal(0n);
    });
  }

  it("rejects the opposite authority signature and a veto without a matching pending rotation", async function () {
    await schedule(1);
    const prepared = await signed("cancel-rotation", { byRecovery: false, nonce: "1", deadline: await deadline() });
    prepared.signatures.authorizer = await recovery.signTypedData(prepared.bundle.domain, prepared.bundle.types, prepared.bundle.message);
    await expect(broadcast(prepared)).to.be.rejectedWith("wrong signer for authorizer");

    await broadcast(await signed("cancel-rotation", { byRecovery: true, nonce: "1", deadline: await deadline() }));
    const stale = await signed("cancel-rotation", { byRecovery: false, nonce: "1", deadline: await deadline() });
    await expect(broadcast(stale)).to.be.rejectedWith("does not match pending rotation");
  });

  it("advertises cancel-rotation in the CLI prepare actions", function () {
    expect(PREPARE_ACTIONS.split("|")).to.include("cancel-rotation");
  });
});