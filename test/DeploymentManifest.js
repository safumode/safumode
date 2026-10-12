const { expect } = require("chai");
const hre = require("hardhat");
const { createManifest, verifyManifest } = require("../scripts/deployment-manifest");

describe("local deployment manifest", function () {
  let vault, manifest, params, signers;

  const Rotate = [
    { name: "authorizer", type: "address" },
    { name: "recoveryAuthorizer", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ];

  async function rotateAuthorities(nextAuthorizer, nextRecovery) {
    const network = await hre.ethers.provider.getNetwork();
    const block = await hre.ethers.provider.getBlock("latest");
    const deadline = block.timestamp + 7200;
    const value = { authorizer: nextAuthorizer, recoveryAuthorizer: nextRecovery, nonce: 1, deadline };
    const domain = {
      name: "Authorization Vault Prototype",
      version: "1:0",
      chainId: network.chainId,
      verifyingContract: await vault.getAddress(),
    };
    await vault.scheduleRotation(nextAuthorizer, nextRecovery, 1, deadline,
      await signers[1].signTypedData(domain, { RotateAuthorities: Rotate }, value),
      await signers[2].signTypedData(domain, { RotateAuthorities: Rotate }, value));
    await hre.ethers.provider.send("evm_increaseTime", [Number(params.delay)]);
    await hre.ethers.provider.send("evm_mine");
    await vault.activateRotation(1);
  }

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

  it("accepts the original deployment identity after legitimate authority rotation", async function () {
    await rotateAuthorities(signers[4].address, signers[5].address);
    expect(await vault.authorizer()).to.equal(signers[4].address);
    expect(await vault.recoveryAuthorizer()).to.equal(signers[5].address);
    await expect(verifyManifest(manifest, hre.ethers.provider)).to.eventually.have.property("address", await vault.getAddress());
  });

  it("rejects tampered initial authorities using deployment calldata", async function () {
    await rotateAuthorities(signers[4].address, signers[5].address);
    const bad = structuredClone(manifest);
    bad.constructor.authorizer = signers[4].address;
    await expect(verifyManifest(bad, hre.ethers.provider)).to.be.rejectedWith("deployment transaction constructor mismatch");
  });

  it("rejects a deployment transaction belonging to another contract", async function () {
    const other = await hre.ethers.deployContract("AuthorizationVault", Object.values(params));
    await other.waitForDeployment();
    const receipt = await other.deploymentTransaction().wait();
    const bad = structuredClone(manifest);
    bad.deployment.transactionHash = receipt.hash;
    bad.deployment.blockNumber = receipt.blockNumber;
    await expect(verifyManifest(bad, hre.ethers.provider)).to.be.rejectedWith("deployment transaction address mismatch");
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
