const { expect } = require("chai");
const hre = require("hardhat");
const { createManifest, verifyManifest } = require("../scripts/deployment-manifest");

describe("local deployment manifest", function () {
  let vault, manifest, params, signers;

  beforeEach(async function () {
    signers = await hre.ethers.getSigners();
    params = {
      authorizer: signers[1].address,
      recoveryAuthorizer: signers[2].address,
      recoveryRecipient: signers[3].address,
      delay: "3600",
    };
    vault = await hre.ethers.deployContract("AuthorizationVault", Object.values(params));
    await vault.waitForDeployment();
    manifest = await createManifest(vault, params, hre.ethers.provider);
  });

  it("pins and verifies chain, address, runtime, constructor state, compiler, and build", async function () {
    const result = await verifyManifest(manifest, hre.ethers.provider);
    expect(result.address).to.equal(await vault.getAddress());
    expect(manifest.chainId).to.equal("31337");
    expect(manifest.runtimeCodeHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(manifest.build.fingerprint).to.match(/^0x[0-9a-f]{64}$/);
    expect(manifest.build.compiler.version).to.match(/^0\.8\.24\+/);
    expect(manifest.constructor).to.deep.equal(params);
  });

  it("rejects the wrong chain", async function () {
    const bad = structuredClone(manifest);
    bad.chainId = "1";
    await expect(verifyManifest(bad, hre.ethers.provider)).to.be.rejectedWith("chain ID mismatch");
  });

  it("rejects wrong code at the pinned address", async function () {
    const other = await hre.ethers.deployContract("AuthorizationVault", [signers[4].address, signers[5].address, signers[6].address, 99]);
    await other.waitForDeployment();
    const bad = structuredClone(manifest);
    bad.address = await other.getAddress();
    await expect(verifyManifest(bad, hre.ethers.provider)).to.be.rejectedWith("runtime code hash mismatch");
  });

  it("rejects incorrect constructor parameters even when runtime hash matches", async function () {
    const bad = structuredClone(manifest);
    bad.constructor.delay = "3599";
    await expect(verifyManifest(bad, hre.ethers.provider)).to.be.rejectedWith("constructor parameter mismatch: delay");
  });

  it("rejects a changed build fingerprint", async function () {
    const bad = structuredClone(manifest);
    bad.build.fingerprint = `0x${"00".repeat(32)}`;
    await expect(verifyManifest(bad, hre.ethers.provider)).to.be.rejectedWith("local build fingerprint mismatch");
  });
});
