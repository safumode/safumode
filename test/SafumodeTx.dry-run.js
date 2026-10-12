const { expect } = require("chai");
const { ethers } = require("hardhat");
const { prepare, relay } = require("../scripts/safumode-tx");
const { loadBuildIdentity } = require("../scripts/deployment-manifest");

describe("SAFUMODE relay dry-run simulation", function () {
  let vault, manifest, authorizer, recovery, recipient, target, relayer;

  beforeEach(async function () {
    [, authorizer, recovery, recipient, target, relayer] = await ethers.getSigners();
    vault = await ethers.deployContract("AuthorizationVault", [
      authorizer.address, recovery.address, recipient.address, 60,
    ]);
    const vaultAddress = await vault.getAddress();
    manifest = {
      schema: "safumode-local-deployment-v1",
      environment: "hardhat-local-only",
      chainId: "31337",
      address: vaultAddress,
      runtimeCodeHash: ethers.keccak256(await ethers.provider.getCode(vaultAddress)),
      constructor: {
        authorizer: authorizer.address,
        recoveryAuthorizer: recovery.address,
        recoveryRecipient: recipient.address,
        delay: "60",
      },
      build: loadBuildIdentity(),
    };
  });

  async function deadline() {
    return String((await ethers.provider.getBlock("latest")).timestamp + 1000);
  }

  async function signed(action, input) {
    const bundle = prepare(manifest, action, input);
    const signatures = {};
    for (const role of Object.keys(bundle.expectedSigners)) {
      signatures[role] = await (role === "authorizer" ? authorizer : recovery)
        .signTypedData(bundle.domain, bundle.types, bundle.message);
    }
    return { bundle, signatures };
  }

  function run(prepared, dryRun) {
    return relay(prepared.bundle, manifest, prepared.signatures, ethers.provider,
      dryRun ? null : relayer, {
        rpcUrl: "http://127.0.0.1",
        dryRun,
        ...(dryRun ? {} : { relayerAddress: relayer.address }),
      });
  }

  it("rejects a paused withdrawal schedule during dry-run", async function () {
    await run(await signed("pause", {
      paused: true, byRecovery: false, nonce: "1", deadline: await deadline(),
    }), false);
    const prepared = await signed("schedule", {
      asset: ethers.ZeroAddress, to: target.address, amount: "1", nonce: "7", deadline: await deadline(),
    });

    await expect(run(prepared, true)).to.be.revertedWithCustomError(vault, "Paused");
    expect(await vault.authorizerNonceUsed(7)).to.equal(false);
  });

  it("rejects an immediate withdrawal to an untrusted recipient during dry-run", async function () {
    const prepared = await signed("withdraw", {
      asset: ethers.ZeroAddress, to: target.address, amount: "1", nonce: "8", deadline: await deadline(),
    });

    await expect(run(prepared, true)).to.be.revertedWithCustomError(vault, "RecipientTrustMismatch");
    expect(await vault.authorizerNonceUsed(8)).to.equal(false);
  });

  it("simulates a valid action without state changes and then relays that exact action", async function () {
    const prepared = await signed("schedule", {
      asset: ethers.ZeroAddress, to: target.address, amount: "1", nonce: "9", deadline: await deadline(),
    });
    const requestId = await vault.scheduleWithdrawal.staticCall(
      prepared.bundle.message.asset,
      prepared.bundle.message.to,
      prepared.bundle.message.amount,
      prepared.bundle.message.nonce,
      prepared.bundle.message.deadline,
      prepared.signatures.authorizer
    );

    const simulation = await run(prepared, true);
    expect(simulation).to.include({ dryRun: true, action: "schedule" });
    expect(await vault.authorizerNonceUsed(9)).to.equal(false);
    expect((await vault.requests(requestId)).executableAt).to.equal(0n);

    const broadcast = await run(prepared, false);
    expect(broadcast.dryRun).to.equal(false);
    expect(await vault.authorizerNonceUsed(9)).to.equal(true);
    expect((await vault.requests(requestId)).executableAt).to.not.equal(0n);
  });
});
