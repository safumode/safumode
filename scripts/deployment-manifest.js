"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const CONTRACT = "AuthorizationVault";
const LOCAL_CHAIN_ID = 31337n;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
function canonical(value) { return JSON.stringify(stable(value)); }
function sha256(data) { return ethers.sha256(ethers.toUtf8Bytes(data)); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

function artifactPath() {
  return path.join(ROOT, "artifacts", "contracts", `${CONTRACT}.sol`, `${CONTRACT}.json`);
}
function loadBuildIdentity() {
  const artifact = readJson(artifactPath());
  const debug = readJson(artifactPath().replace(/\.json$/, ".dbg.json"));
  const buildInfo = readJson(path.resolve(path.dirname(artifactPath()), debug.buildInfo));
  const lock = fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8");
  const sources = {};
  for (const [name, entry] of Object.entries(buildInfo.input.sources)) {
    sources[name] = ethers.keccak256(ethers.toUtf8Bytes(entry.content));
  }
  const build = {
    contract: `${artifact.sourceName}:${artifact.contractName}`,
    compiler: {
      version: buildInfo.solcLongVersion,
      optimizer: buildInfo.input.settings.optimizer,
      evmVersion: buildInfo.input.settings.evmVersion,
    },
    compilerInputHash: sha256(canonical(buildInfo.input)),
    sources,
    packageLockSha256: sha256(lock),
    creationBytecodeHash: ethers.keccak256(artifact.bytecode),
    deployedBytecodeTemplateHash: ethers.keccak256(artifact.deployedBytecode),
  };
  return { ...build, fingerprint: sha256(canonical(build)) };
}

function normalizeParams(params) {
  return {
    authorizer: ethers.getAddress(params.authorizer),
    recoveryAuthorizer: ethers.getAddress(params.recoveryAuthorizer),
    recoveryRecipient: ethers.getAddress(params.recoveryRecipient),
    delay: BigInt(params.delay).toString(),
  };
}

function deploymentData(artifact, params) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "uint64"],
    [params.authorizer, params.recoveryAuthorizer, params.recoveryRecipient, params.delay]
  );
  return ethers.concat([artifact.bytecode, encoded]);
}

async function createManifest(contract, params, provider) {
  const address = await contract.getAddress();
  const network = await provider.getNetwork();
  if (network.chainId !== LOCAL_CHAIN_ID) throw new Error(`refusing non-local chain ID ${network.chainId}`);
  const code = await provider.getCode(address);
  if (code === "0x") throw new Error("deployment has no runtime code");
  const tx = contract.deploymentTransaction();
  const receipt = tx && await tx.wait();
  return {
    schema: "safumode-local-deployment-v1",
    environment: "hardhat-local-only",
    chainId: network.chainId.toString(),
    address: ethers.getAddress(address),
    runtimeCodeHash: ethers.keccak256(code),
    constructor: normalizeParams(params),
    deployment: { transactionHash: receipt ? receipt.hash : null, blockNumber: receipt ? receipt.blockNumber : null },
    build: loadBuildIdentity(),
  };
}

async function verifyManifest(manifest, provider, options = {}) {
  const errors = [];
  if (manifest.schema !== "safumode-local-deployment-v1") errors.push("unsupported manifest schema");
  if (manifest.environment !== "hardhat-local-only") errors.push("manifest is not marked local-only");
  const network = await provider.getNetwork();
  if (network.chainId !== LOCAL_CHAIN_ID) errors.push(`RPC chain is ${network.chainId}, expected local Hardhat ${LOCAL_CHAIN_ID}`);
  if (network.chainId.toString() !== String(manifest.chainId)) errors.push(`chain ID mismatch: RPC ${network.chainId}, manifest ${manifest.chainId}`);
  let address;
  try { address = ethers.getAddress(manifest.address); } catch (_) { errors.push("invalid manifest address"); }
  let expected;
  try { expected = normalizeParams(manifest.constructor || {}); } catch (_) { errors.push("invalid constructor parameters"); }
  if (address) {
    const code = await provider.getCode(address);
    if (code === "0x") errors.push("no code at manifest address");
    else if (ethers.keccak256(code) !== manifest.runtimeCodeHash) errors.push("runtime code hash mismatch");
    if (code !== "0x") {
      const artifact = readJson(artifactPath());
      const vault = new ethers.Contract(address, artifact.abi, provider);
      const reads = await Promise.allSettled([vault.recoveryRecipient(), vault.delay()]);
      if (reads.some((r) => r.status === "rejected")) errors.push("contract immutable-state reads failed");
      else if (expected) {
        const actual = { recoveryRecipient: ethers.getAddress(reads[0].value), delay: BigInt(reads[1].value).toString() };
        for (const key of Object.keys(actual)) if (actual[key] !== expected[key]) errors.push(`constructor parameter mismatch: ${key}`);
      }

      // The authorities are mutable. Prove their initial values, along with all
      // constructor parameters, from the successful creation transaction. This
      // preserves deployment identity without rejecting legitimate rotations.
      const deployment = manifest.deployment || {};
      if (!ethers.isHexString(deployment.transactionHash, 32)) {
        errors.push("invalid deployment transaction hash");
      } else {
        const [tx, receipt] = await Promise.all([
          provider.getTransaction(deployment.transactionHash),
          provider.getTransactionReceipt(deployment.transactionHash),
        ]);
        if (!tx || !receipt) errors.push("deployment transaction not found on chain");
        else {
          if (tx.to !== null) errors.push("deployment transaction is not contract creation");
          if (receipt.status !== 1) errors.push("deployment transaction was not successful");
          if (!receipt.contractAddress || ethers.getAddress(receipt.contractAddress) !== address) errors.push("deployment transaction address mismatch");
          if (deployment.blockNumber == null || Number(deployment.blockNumber) !== receipt.blockNumber) errors.push("deployment block number mismatch");
          if (expected && ethers.keccak256(tx.data) !== ethers.keccak256(deploymentData(artifact, expected))) {
            errors.push("deployment transaction constructor mismatch");
          }
        }
      }
    }
  }
  if (!options.skipLocalBuild) {
    const local = loadBuildIdentity();
    if (!manifest.build || local.fingerprint !== manifest.build.fingerprint) errors.push("local build fingerprint mismatch");
    else if (canonical(local) !== canonical(manifest.build)) errors.push("build identity fields mismatch");
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return { chainId: network.chainId.toString(), address, runtimeCodeHash: manifest.runtimeCodeHash, buildFingerprint: manifest.build.fingerprint };
}

module.exports = { LOCAL_CHAIN_ID, canonical, createManifest, loadBuildIdentity, normalizeParams, verifyManifest };
