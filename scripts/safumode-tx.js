"use strict";

const fs = require("fs");
const { ethers } = require("ethers");
const { loadBuildIdentity } = require("./deployment-manifest");

const LOCAL_CHAIN_ID = 31337n;
const DOMAIN_NAME = "Authorization Vault Prototype";
const ACTIONS = Object.freeze({
  schedule: { primaryType: "Withdraw", roles: ["authorizer"], fields: [["asset","address"],["to","address"],["amount","uint256"],["nonce","uint256"],["deadline","uint256"],["immediate","bool"]], fixed: { immediate: false }, method: "scheduleWithdrawal" },
  withdraw: { primaryType: "Withdraw", roles: ["authorizer"], fields: [["asset","address"],["to","address"],["amount","uint256"],["nonce","uint256"],["deadline","uint256"],["immediate","bool"]], fixed: { immediate: true }, method: "withdrawTrusted" },
  recover: { primaryType: "Recover", roles: ["recoveryAuthorizer"], fields: [["asset","address"],["amount","uint256"],["nonce","uint256"],["deadline","uint256"]], method: "recover" },
  trust: { primaryType: "SetTrusted", roles: (m) => m.trusted ? ["authorizer","recoveryAuthorizer"] : ["authorizer"], fields: [["account","address"],["trusted","bool"],["nonce","uint256"],["deadline","uint256"]], method: (m) => m.trusted ? "scheduleTrust" : "revokeTrust" },
  cancel: { primaryType: "Cancel", roles: (m) => [m.byRecovery ? "recoveryAuthorizer" : "authorizer"], fields: [["requestId","bytes32"],["nonce","uint256"],["deadline","uint256"]], method: "cancelWithdrawal", metadata: ["byRecovery"] },
  pause: { primaryType: "SetPaused", roles: (m) => m.paused ? [m.byRecovery ? "recoveryAuthorizer" : "authorizer"] : ["authorizer","recoveryAuthorizer"], fields: [["paused","bool"],["nonce","uint256"],["deadline","uint256"]], method: "setPaused", metadata: ["byRecovery"] },
  rotate: { primaryType: "RotateAuthorities", roles: ["authorizer","recoveryAuthorizer"], fields: [["authorizer","address"],["recoveryAuthorizer","address"],["nonce","uint256"],["deadline","uint256"]], method: "scheduleRotation" },
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function canonical(value) { return JSON.stringify(stable(value), null, 2) + "\n"; }
function fail(message) { throw new Error(message); }
function bool(value, name) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  fail(`${name} must be true or false`);
}
function uint(value, name) {
  if (value === undefined || value === null || !/^(0|[1-9][0-9]*)$/.test(String(value))) fail(`${name} must be an unsigned decimal integer`);
  return BigInt(value).toString();
}
function address(value, name) { try { return ethers.getAddress(value); } catch (_) { fail(`${name} must be a valid address`); } }
function loadManifest(fileOrObject) {
  const m = typeof fileOrObject === "string" ? JSON.parse(fs.readFileSync(fileOrObject, "utf8")) : fileOrObject;
  if (!m || !["safumode-local-deployment-v1", "safumode-deployment-v1"].includes(m.schema)) fail("unsupported deployment manifest schema");
  if (!m.build || !ethers.isHexString(m.build.fingerprint, 32)) fail("manifest is not pinned to a build fingerprint");
  let localBuild;
  try { localBuild = loadBuildIdentity(); } catch (error) { fail(`cannot verify local build fingerprint: ${error.message}`); }
  if (m.build.fingerprint !== localBuild.fingerprint) fail("manifest build fingerprint does not match local artifacts");
  if (!ethers.isHexString(m.runtimeCodeHash, 32)) fail("manifest is not pinned to a runtime code hash");
  return m;
}
function prepare(manifestInput, action, input, options = {}) {
  const manifest = loadManifest(manifestInput);
  const spec = ACTIONS[action];
  if (!spec) fail(`unsupported action: ${action}`);
  const message = {};
  for (const [name, type] of spec.fields) {
    let value = Object.prototype.hasOwnProperty.call(spec.fixed || {}, name) ? spec.fixed[name] : input[name];
    if (type === "address") value = address(value, name);
    else if (type === "uint256") value = uint(value, name);
    else if (type === "bool") value = bool(value, name);
    else if (type === "bytes32" && !ethers.isHexString(value, 32)) fail(`${name} must be bytes32`);
    message[name] = value;
  }
  const metadata = {};
  for (const name of spec.metadata || []) metadata[name] = bool(input[name], name);
  const roles = typeof spec.roles === "function" ? spec.roles({...message,...metadata}) : spec.roles;
  const signerSource = manifest.authorities || manifest.constructor || {};
  const expectedSigners = {};
  for (const role of roles) expectedSigners[role] = address(signerSource[role], `manifest authority ${role}`);
  const version = options.version || (manifest.eip712 && manifest.eip712.version) || "1:0";
  if (!/^1:[0-9]+$/.test(version)) fail("invalid EIP-712 version; expected epoch-specific 1:N");
  const domain = { name: DOMAIN_NAME, version, chainId: uint(manifest.chainId, "manifest chainId"), verifyingContract: address(manifest.address, "manifest address") };
  const types = { [spec.primaryType]: spec.fields.map(([name,type]) => ({name,type})) };
  return stable({ schema: "safumode-typed-transaction-v1", action, manifestPin: { buildFingerprint: manifest.build.fingerprint, runtimeCodeHash: manifest.runtimeCodeHash }, domain, primaryType: spec.primaryType, types, message, metadata, expectedSigners });
}
function digest(bundle) { return ethers.TypedDataEncoder.hash(bundle.domain, bundle.types, bundle.message); }
function verifySignatures(bundle, signatures) {
  const recovered = {};
  for (const [role, expected] of Object.entries(bundle.expectedSigners)) {
    const signature = signatures && signatures[role];
    if (!signature) fail(`missing ${role} signature`);
    let signer; try { signer = ethers.verifyTypedData(bundle.domain, bundle.types, bundle.message, signature); } catch (_) { fail(`invalid ${role} signature`); }
    if (signer !== expected) fail(`wrong signer for ${role}: expected ${expected}, recovered ${signer}`);
    recovered[role] = signer;
  }
  return recovered;
}
async function validateRelay(bundle, manifestInput, signatures, provider) {
  const manifest = loadManifest(manifestInput);
  const rebuilt = prepare(manifest, bundle.action, {...bundle.message,...bundle.metadata}, {version: bundle.domain && bundle.domain.version});
  if (canonical(rebuilt) !== canonical(bundle)) fail("bundle typed fields/domain/manifest pin are not canonical or do not match manifest");
  const network = await provider.getNetwork();
  if (network.chainId.toString() !== bundle.domain.chainId) fail("RPC chain does not match typed-data chain");
  const code = await provider.getCode(bundle.domain.verifyingContract);
  if (code === "0x" || ethers.keccak256(code) !== manifest.runtimeCodeHash) fail("deployed runtime code does not match manifest pin");
  const artifact = require("../artifacts/contracts/AuthorizationVault.sol/AuthorizationVault.json");
  const vault = new ethers.Contract(bundle.domain.verifyingContract, artifact.abi, provider);
  if (await vault.VERSION() !== bundle.domain.version || await vault.domainSeparator() !== ethers.TypedDataEncoder.hashDomain(bundle.domain)) fail("on-chain EIP-712 domain mismatch");
  const currentAuthorities = {
    authorizer: address(await vault.authorizer(), "on-chain authorizer"),
    recoveryAuthorizer: address(await vault.recoveryAuthorizer(), "on-chain recoveryAuthorizer"),
  };
  for (const [role, expected] of Object.entries(bundle.expectedSigners)) {
    if (currentAuthorities[role] !== expected) fail(`stale signer metadata for ${role}: on-chain authority is ${currentAuthorities[role]}`);
  }
  const block = await provider.getBlock("latest");
  if (BigInt(bundle.message.deadline) < BigInt(block.timestamp)) fail("authorization deadline has expired");
  const a = bundle.action, n = BigInt(bundle.message.nonce);
  if (["schedule","withdraw"].includes(a) && await vault.authorizerNonceUsed(n)) fail("authorizer nonce already used");
  if (a === "recover" && await vault.recoveryNonceUsed(n)) fail("recovery nonce already used");
  if (a === "cancel" && await vault[bundle.metadata.byRecovery ? "recoveryNonceUsed" : "authorizerNonceUsed"](n)) fail("cancel nonce already used");
  if (a === "trust" && n !== (await vault.trustNonce(bundle.message.account)) + 1n) fail("invalid trust nonce");
  if (a === "pause" && n !== (await vault.controlNonce()) + 1n) fail("invalid control nonce");
  if (a === "rotate" && n !== (await vault.rotationNonce()) + 1n) fail("invalid rotation nonce");
  verifySignatures(bundle, signatures);
  return vault;
}
async function relay(bundle, manifest, signatures, provider, relayer, options = {}) {
  if (!options.rpcUrl || typeof options.rpcUrl !== "string") fail("rpcUrl is required");
  let rpc;
  try { rpc = new URL(options.rpcUrl); } catch (_) { fail("rpcUrl must be a valid URL"); }
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(rpc.hostname)) fail("relay library is local-only; rpcUrl must use a loopback hostname");
  const vault = await validateRelay(bundle, manifest, signatures, provider);
  if ((await provider.getNetwork()).chainId !== LOCAL_CHAIN_ID) fail(`relay library is local-only; expected chain ${LOCAL_CHAIN_ID}`);
  if (options.dryRun) return { dryRun: true, digest: digest(bundle), action: bundle.action };
  if (!relayer) fail("local broadcast requires an unlocked RPC relayer");
  if (!options.relayerAddress) fail("local broadcast requires an explicit relayerAddress");
  const selectedRelayer = address(options.relayerAddress, "relayerAddress");
  let unlocked;
  try { unlocked = address(await relayer.getAddress(), "unlocked relayer"); } catch (_) { fail("unable to resolve unlocked RPC relayer"); }
  if (unlocked !== selectedRelayer) fail(`unlocked relayer does not match explicit relayerAddress: expected ${selectedRelayer}, got ${unlocked}`);
  const v = vault.connect(relayer), m = bundle.message, s = signatures, md = bundle.metadata;
  let tx;
  if (bundle.action === "schedule") tx = await v.scheduleWithdrawal(m.asset,m.to,m.amount,m.nonce,m.deadline,s.authorizer);
  if (bundle.action === "withdraw") tx = await v.withdrawTrusted(m.asset,m.to,m.amount,m.nonce,m.deadline,s.authorizer);
  if (bundle.action === "recover") tx = await v.recover(m.asset,m.amount,m.nonce,m.deadline,s.recoveryAuthorizer);
  if (bundle.action === "trust") tx = m.trusted ? await v.scheduleTrust(m.account,m.nonce,m.deadline,s.authorizer,s.recoveryAuthorizer) : await v.revokeTrust(m.account,m.nonce,m.deadline,s.authorizer);
  if (bundle.action === "cancel") tx = await v.cancelWithdrawal(m.requestId,md.byRecovery,m.nonce,m.deadline,s[md.byRecovery?"recoveryAuthorizer":"authorizer"]);
  if (bundle.action === "pause") tx = await v.setPaused(m.paused,md.byRecovery,m.nonce,m.deadline,s[md.byRecovery?"recoveryAuthorizer":"authorizer"],s.recoveryAuthorizer || "0x");
  if (bundle.action === "rotate") tx = await v.scheduleRotation(m.authorizer,m.recoveryAuthorizer,m.nonce,m.deadline,s.authorizer,s.recoveryAuthorizer);
  const receipt = await tx.wait();
  return { dryRun: false, transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
}
module.exports = { ACTIONS, LOCAL_CHAIN_ID, canonical, digest, loadManifest, prepare, relay, validateRelay, verifySignatures };
