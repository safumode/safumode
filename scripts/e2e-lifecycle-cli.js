#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { ethers } = require("ethers");
const { createManifest } = require("./deployment-manifest");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const artifact = require("../artifacts/contracts/AuthorizationVault.sol/AuthorizationVault.json");
const trustTypes = { SetTrusted: [
  { name: "account", type: "address" },
  { name: "trusted", type: "bool" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] };

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForRpc(provider, node, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (node.exitCode !== null) throw new Error(`Hardhat node exited early (${node.exitCode})\n${logs.join("")}`);
    try { if (await provider.send("eth_chainId", []) === "0x7a69") return; } catch (_) { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Hardhat node did not become ready\n${logs.join("")}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve => child.once("exit", resolve)),
    new Promise(resolve => setTimeout(resolve, 3000)).then(() => { if (child.exitCode === null) child.kill("SIGKILL"); }),
  ]);
}

async function cli(args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(ROOT, "scripts/safumode-cli.js"), ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH },
  });
  assert.equal(stderr, "", `CLI wrote stderr: ${stderr}`);
  return { raw: stdout, value: JSON.parse(stdout) };
}

async function main() {
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "safumode-lifecycle-e2e-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  const logs = [];
  const node = spawn(process.execPath, [path.join(ROOT, "node_modules/hardhat/internal/cli/cli.js"), "node", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  node.stdout.on("data", data => logs.push(data.toString()));
  node.stderr.on("data", data => logs.push(data.toString()));
  const cleanup = async () => { await stop(node); await fs.rm(tempDir, { recursive: true, force: true }); };
  const onSignal = signal => { cleanup().finally(() => process.kill(process.pid, signal)); };
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);

  try {
    // The node is created by this test with a fixed local chain id; staticNetwork
    // also avoids ethers emitting startup retries while the child process boots.
    const provider = new ethers.JsonRpcProvider(rpc, 31337, { staticNetwork: true });
    await waitForRpc(provider, node, logs);
    const [relayer, authorizer, recovery, recipient, account] = await Promise.all([0, 1, 2, 3, 4].map(i => provider.getSigner(i)));
    const [relayerAddress, authorizerAddress, recoveryAddress, recipientAddress, accountAddress] = await Promise.all(
      [relayer, authorizer, recovery, recipient, account].map(signer => signer.getAddress())
    );
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, relayer);
    const vault = await factory.deploy(authorizerAddress, recoveryAddress, recipientAddress, 1);
    await vault.waitForDeployment();
    const manifest = await createManifest(vault, {
      authorizer: authorizerAddress, recoveryAuthorizer: recoveryAddress, recoveryRecipient: recipientAddress, delay: 1,
    }, provider);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const latest = await provider.getBlock("latest");
    const domain = { name: "Authorization Vault Prototype", version: await vault.VERSION(), chainId: 31337, verifyingContract: await vault.getAddress() };
    const value = { account: accountAddress, trusted: true, nonce: 1, deadline: latest.timestamp + 3600 };
    const [authorizerSignature, recoverySignature] = await Promise.all([
      authorizer.signTypedData(domain, trustTypes, value), recovery.signTypedData(domain, trustTypes, value),
    ]);
    await (await vault.scheduleTrust(value.account, value.nonce, value.deadline, authorizerSignature, recoverySignature)).wait();
    await provider.send("evm_increaseTime", [2]);
    await provider.send("evm_mine", []);

    const common = ["lifecycle", "--manifest", manifestPath, "--rpc", rpc, "--action", "activate-trust", "--account", accountAddress, "--nonce", "1"];
    const dryRun = await cli(common);
    assert.deepEqual(dryRun.value, { action: "activate-trust", address: await vault.getAddress(), dryRun: true, method: "activateTrust" });
    assert.equal(await vault.trusted(accountAddress), false, "dry-run changed contract state");

    const broadcast = await cli([...common, "--broadcast", "--relayer", relayerAddress, "--relayer-index", "0"]);
    assert.equal(broadcast.value.dryRun, false);
    assert.match(broadcast.value.transactionHash, /^0x[0-9a-f]{64}$/);
    const receipt = await provider.getTransactionReceipt(broadcast.value.transactionHash);
    assert.ok(receipt, "broadcast transaction has no receipt");
    assert.equal(receipt.status, 1, "broadcast transaction reverted");
    assert.equal(await vault.trusted(accountAddress), true, "activate-trust final state was not applied");

    process.stdout.write(`RPC: ${rpc} (ephemeral Hardhat chain 31337)\n`);
    process.stdout.write(`dry-run: ${dryRun.raw}\n`);
    process.stdout.write(`broadcast: ${broadcast.raw}\n`);
    process.stdout.write(`receipt: hash=${receipt.hash} status=${receipt.status} blockNumber=${receipt.blockNumber}\n`);
    process.stdout.write(`final-state: trusted(${accountAddress})=true\n`);
    process.stdout.write("PASS: lifecycle CLI dry-run preserved state; broadcast receipt and final state verified\n");
  } finally {
    process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
    await cleanup();
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
