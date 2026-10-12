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
  if (address) {
    const code = await provider.getCode(address);
    if (code === "0x") errors.push("no code at manifest address");
    else if (ethers.keccak256(code) !== manifest.runtimeCodeHash) errors.push("runtime code hash mismatch");
    if (code !== "0x") {
      const artifact = readJson(artifactPath());
      const vault = new ethers.Contract(address, artifact.abi, provider);
      const expected = normalizeParams(manifest.constructor || {});
      const reads = await Promise.allSettled([vault.authorizer(), vault.recoveryAuthorizer(), vault.recoveryRecipient(), vault.delay()]);
      if (reads.some((r) => r.status === "rejected")) errors.push("contract constructor-state reads failed");
      else {
        const actual = normalizeParams({ authorizer: reads[0].value, recoveryAuthorizer: reads[1].value, recoveryRecipient: reads[2].value, delay: reads[3].value });
        for (const key of Object.keys(expected)) if (actual[key] !== expected[key]) errors.push(`constructor parameter mismatch: ${key}`);
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
