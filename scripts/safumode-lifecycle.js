"use strict";

const { ethers } = require("ethers");
const { LOCAL_CHAIN_ID, loadManifest } = require("./safumode-tx");
const { verifyManifest } = require("./deployment-manifest");

const ACTIONS = Object.freeze({
  "activate-trust": { method: "activateTrust", args: ["account", "nonce"] },
  "execute-withdrawal": { method: "executeWithdrawal", args: ["requestId"] },
  "activate-rotation": { method: "activateRotation", args: ["nonce"] },
});

function fail(message) { throw new Error(message); }
function uint(value, name) {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(String(value))) fail(`${name} must be an unsigned decimal integer`);
  return BigInt(value);
}
function address(value, name) { try { return ethers.getAddress(value); } catch (_) { fail(`${name} must be a valid address`); } }
function loopback(rpcUrl) {
  if (!rpcUrl || typeof rpcUrl !== "string") fail("rpcUrl is required");
  let rpc; try { rpc = new URL(rpcUrl); } catch (_) { fail("rpcUrl must be a valid URL"); }
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(rpc.hostname)) fail("lifecycle library is local-only; rpcUrl must use a loopback hostname");
}

async function preflight(manifestInput, action, input, provider, rpcUrl) {
  loopback(rpcUrl);
  const spec = ACTIONS[action];
  if (!spec) fail(`unsupported lifecycle action: ${action}`);
  const manifest = loadManifest(manifestInput);
  await verifyManifest(manifest, provider);
  const network = await provider.getNetwork();
  if (network.chainId !== LOCAL_CHAIN_ID) fail(`lifecycle library is local-only; expected chain ${LOCAL_CHAIN_ID}`);
  const artifact = require("../artifacts/contracts/AuthorizationVault.sol/AuthorizationVault.json");
  const vault = new ethers.Contract(manifest.address, artifact.abi, provider);
  const block = await provider.getBlock("latest");
  const epoch = await vault.authorityEpoch();
  let callArgs;

  if (action === "activate-trust") {
    const account = address(input.account, "account"), nonce = uint(input.nonce, "nonce");
    const [paused, pending, currentNonce, pendingEpoch] = await Promise.all([
      vault.paused(), vault.pendingTrust(account), vault.trustNonce(account), vault.pendingTrustEpoch(account)
    ]);
    if (paused) fail("vault is paused");
    if (pending.executableAt === 0n || pending.nonce !== nonce || currentNonce !== nonce || pendingEpoch !== epoch) fail("trust activation does not exactly match current pending state");
    if (BigInt(block.timestamp) < pending.executableAt) fail("trust activation is too early");
    callArgs = [account, nonce];
  } else if (action === "execute-withdrawal") {
    if (!ethers.isHexString(input.requestId, 32)) fail("requestId must be bytes32");
    const requestId = input.requestId.toLowerCase();
    const [paused, request] = await Promise.all([vault.paused(), vault.requests(requestId)]);
    // requestEpoch is private in the contract. A static call below is the authoritative epoch check.
    if (paused) fail("vault is paused");
    if (request.executableAt === 0n || request.cancelled || request.executed) fail("withdrawal does not exactly match a live pending request");
    if (BigInt(block.timestamp) < request.executableAt) fail("withdrawal execution is too early");
    callArgs = [requestId];
  } else {
    const nonce = uint(input.nonce, "nonce");
    const [pending, currentNonce] = await Promise.all([vault.pendingRotation(), vault.rotationNonce()]);
    if (pending.executableAt === 0n || pending.nonce !== nonce || currentNonce !== nonce) fail("rotation activation does not exactly match current pending state");
    if (BigInt(block.timestamp) < pending.executableAt) fail("rotation activation is too early");
    callArgs = [nonce];
  }
  await vault[spec.method].staticCall(...callArgs);
  return { action, method: spec.method, callArgs, manifest, vault };
}

async function lifecycle(manifestInput, action, input, provider, relayer, options = {}) {
  const checked = await preflight(manifestInput, action, input || {}, provider, options.rpcUrl);
  if (!options.broadcast) return { dryRun: true, action, method: checked.method, address: ethers.getAddress(checked.manifest.address) };
  if (!relayer) fail("local broadcast requires an unlocked RPC relayer");
  // Keep the state checks and transaction submission on one provider. Address
  // equality cannot establish this when one account is exposed by two RPCs.
  if (relayer.provider !== provider) fail("local broadcast relayer provider does not match checked provider");
  if (!options.relayerAddress) fail("local broadcast requires an explicit relayerAddress");
  const selected = address(options.relayerAddress, "relayerAddress");
  let unlocked; try { unlocked = address(await relayer.getAddress(), "unlocked relayer"); } catch (_) { fail("unable to resolve unlocked RPC relayer"); }
  if (unlocked !== selected) fail(`unlocked relayer does not match explicit relayerAddress: expected ${selected}, got ${unlocked}`);
  const tx = await checked.vault.connect(relayer)[checked.method](...checked.callArgs);
  const receipt = await tx.wait();
  return { dryRun: false, action, method: checked.method, address: ethers.getAddress(checked.manifest.address), transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
}

module.exports = { ACTIONS, lifecycle, preflight };
