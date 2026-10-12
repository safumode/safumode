"use strict";

// A deliberately local-only operational rehearsal. Authority keys are generated in
// memory, sign EIP-712 data offline, and are never connected to a provider.
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");
const { loadBuildIdentity } = require("./deployment-manifest");
const { prepare, relay } = require("./safumode-tx");

const LOCAL_RPC = "http://127.0.0.1:8545";
const LOCAL_CHAIN_ID = 31337n;

async function runOperatorDrill(options = {}) {
  const network = await ethers.provider.getNetwork();
  assert.equal(network.chainId, LOCAL_CHAIN_ID, "operator drill requires Hardhat chain 31337");

  const [deployer, relayer] = await ethers.getSigners();
  // These are the only authority keys used by this drill. They are ephemeral and
  // remain offline (no provider); the unlocked Hardhat account only relays.
  const authorizer = ethers.Wallet.createRandom();
  const recoveryAuthorizer = ethers.Wallet.createRandom();
  const recoveryRecipient = ethers.Wallet.createRandom().address;
  const trustedRecipient = ethers.Wallet.createRandom().address;
  const untrustedRecipient = ethers.Wallet.createRandom().address;
  const vetoedAuthorizer = ethers.Wallet.createRandom();
  const vetoedRecoveryAuthorizer = ethers.Wallet.createRandom();
  const nextAuthorizer = ethers.Wallet.createRandom();
  const nextRecoveryAuthorizer = ethers.Wallet.createRandom();
  const delay = options.delay || 60;

  const vault = await ethers.deployContract("AuthorizationVault", [
    authorizer.address, recoveryAuthorizer.address, recoveryRecipient, delay,
  ]);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  const code = await ethers.provider.getCode(vaultAddress);
  const manifest = {
    schema: "safumode-local-deployment-v1",
    environment: "hardhat-local-only",
    chainId: network.chainId.toString(),
    address: vaultAddress,
    runtimeCodeHash: ethers.keccak256(code),
    constructor: {
      authorizer: authorizer.address,
      recoveryAuthorizer: recoveryAuthorizer.address,
      recoveryRecipient,
      delay: String(delay),
    },
    build: loadBuildIdentity(),
  };

  await (await deployer.sendTransaction({ to: vaultAddress, value: ethers.parseEther("10") })).wait();
  assert.equal(await ethers.provider.getBalance(vaultAddress), ethers.parseEther("10"));

  async function deadline() {
    return String((await ethers.provider.getBlock("latest")).timestamp + 3600);
  }
  async function signAndRelay(action, input, wallets = { authorizer, recoveryAuthorizer }) {
    const bundle = prepare(manifest, action, input);
    const signatures = {};
    for (const role of Object.keys(bundle.expectedSigners)) {
      assert.ok(wallets[role], `missing offline wallet for ${role}`);
      signatures[role] = await wallets[role].signTypedData(bundle.domain, bundle.types, bundle.message);
    }
    const result = await relay(bundle, manifest, signatures, ethers.provider, relayer, {
      rpcUrl: LOCAL_RPC,
      relayerAddress: await relayer.getAddress(),
    });
    assert.equal(result.dryRun, false);
    return { bundle, signatures, result };
  }

  // Establish trust with both authorities' offline signatures.
  await signAndRelay("trust", { account: trustedRecipient, trusted: true, nonce: 1, deadline: await deadline() });
  assert.equal((await vault.pendingTrust(trustedRecipient)).nonce, 1n);

  // Recovery authority pauses; both authorities are required to resume.
  await signAndRelay("pause", { paused: true, byRecovery: true, nonce: 1, deadline: await deadline() });
  assert.equal(await vault.paused(), true);
  await signAndRelay("pause", { paused: false, byRecovery: false, nonce: 2, deadline: await deadline() });
  assert.equal(await vault.paused(), false);

  await ethers.provider.send("evm_increaseTime", [delay]);
  await ethers.provider.send("evm_mine", []);
  await (await vault.connect(relayer).activateTrust(trustedRecipient, 1)).wait();
  assert.equal(await vault.trusted(trustedRecipient), true);

  // Exercise immediate trusted outflow and delayed untrusted scheduling.
  await signAndRelay("withdraw", {
    asset: ethers.ZeroAddress, to: trustedRecipient, amount: ethers.parseEther("1").toString(),
    nonce: 1, deadline: await deadline(),
  });
  assert.equal(await ethers.provider.getBalance(vaultAddress), ethers.parseEther("9"));

  const scheduled = prepare(manifest, "schedule", {
    asset: ethers.ZeroAddress, to: untrustedRecipient, amount: ethers.parseEther("2").toString(),
    nonce: 2, deadline: await deadline(),
  });
  const scheduleSignature = await authorizer.signTypedData(scheduled.domain, scheduled.types, scheduled.message);
  const requestId = await vault.scheduleWithdrawal.staticCall(
    scheduled.message.asset, scheduled.message.to, scheduled.message.amount,
    scheduled.message.nonce, scheduled.message.deadline, scheduleSignature,
  );
  await relay(scheduled, manifest, { authorizer: scheduleSignature }, ethers.provider, relayer, {
    rpcUrl: LOCAL_RPC, relayerAddress: await relayer.getAddress(),
  });
  assert.equal((await vault.requests(requestId)).cancelled, false);
  await signAndRelay("cancel", { requestId, byRecovery: true, nonce: 1, deadline: await deadline() });
  assert.equal((await vault.requests(requestId)).cancelled, true);

  const recoveryBefore = await ethers.provider.getBalance(recoveryRecipient);
  await signAndRelay("recover", {
    asset: ethers.ZeroAddress, amount: ethers.parseEther("1").toString(), nonce: 2, deadline: await deadline(),
  });
  assert.equal(await ethers.provider.getBalance(recoveryRecipient), recoveryBefore + ethers.parseEther("1"));
  assert.equal(await ethers.provider.getBalance(vaultAddress), ethers.parseEther("8"));

  // Rehearse the break-glass rotation veto as distinct operator steps: prepare
  // offline, obtain one independent authority signature, then use the guarded
  // loopback relay. The recovery authority can veto without the authorizer.
  await signAndRelay("rotate", {
    authorizer: vetoedAuthorizer.address,
    recoveryAuthorizer: vetoedRecoveryAuthorizer.address,
    nonce: 1,
    deadline: await deadline(),
  });
  assert.equal((await vault.pendingRotation()).nonce, 1n);

  const veto = prepare(manifest, "cancel-rotation", {
    byRecovery: true,
    nonce: 1,
    deadline: await deadline(),
  });
  assert.deepEqual(Object.keys(veto.expectedSigners), ["recoveryAuthorizer"]);
  const vetoSignature = await recoveryAuthorizer.signTypedData(veto.domain, veto.types, veto.message);
  const vetoResult = await relay(
    veto,
    manifest,
    { recoveryAuthorizer: vetoSignature },
    ethers.provider,
    relayer,
    { rpcUrl: LOCAL_RPC, relayerAddress: await relayer.getAddress() },
  );
  assert.equal(vetoResult.dryRun, false);
  assert.equal((await vault.pendingRotation()).executableAt, 0n);
  assert.equal(await vault.rotationNonce(), 1n);
  assert.equal(await vault.authorizer(), authorizer.address);
  assert.equal(await vault.recoveryAuthorizer(), recoveryAuthorizer.address);

  // The cancelled nonce is consumed. Schedule a fresh pair and activate it
  // after the delay, proving normal rotation remains available after a veto.
  await signAndRelay("rotate", {
    authorizer: nextAuthorizer.address,
    recoveryAuthorizer: nextRecoveryAuthorizer.address,
    nonce: 2,
    deadline: await deadline(),
  });
  assert.equal((await vault.pendingRotation()).nonce, 2n);
  await ethers.provider.send("evm_increaseTime", [delay]);
  await ethers.provider.send("evm_mine", []);
  await (await vault.connect(relayer).activateRotation(2)).wait();
  assert.equal(await vault.authorizer(), nextAuthorizer.address);
  assert.equal(await vault.recoveryAuthorizer(), nextRecoveryAuthorizer.address);
  assert.equal(await vault.authorityEpoch(), 1n);
  assert.equal(await vault.VERSION(), "1:1");

  const summary = {
    chainId: network.chainId.toString(),
    vault: vaultAddress,
    relayer: await relayer.getAddress(),
    authorityEpoch: "1",
    vetoedRotationNonce: "1",
    activatedRotationNonce: "2",
    vetoingAuthority: recoveryAuthorizer.address,
    vetoUsedIndependentSignature: true,
    vetoUsedGuardedLocalRelay: true,
    finalBalance: (await ethers.provider.getBalance(vaultAddress)).toString(),
    requestId,
    assertions: "passed",
  };
  if (!options.quiet) console.log("SAFUMODE local operator drill passed\n" + JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  runOperatorDrill().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runOperatorDrill };
