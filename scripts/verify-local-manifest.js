#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { verifyManifest } = require("./deployment-manifest");

async function main() {
  const manifestFile = path.resolve(process.argv[2] || "deployments/hardhat-local.json");
  const rpc = process.argv[3] || process.env.SAFUMODE_RPC_URL || "http://127.0.0.1:8545";
  const url = new URL(rpc);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) throw new Error("refusing non-loopback RPC URL");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const result = await verifyManifest(manifest, new ethers.JsonRpcProvider(rpc));
  console.log(`VERIFIED ${result.address}`);
  console.log(`chainId=${result.chainId}`);
  console.log(`runtimeCodeHash=${result.runtimeCodeHash}`);
  console.log(`buildFingerprint=${result.buildFingerprint}`);
}
main().catch((error) => { console.error(`VERIFICATION FAILED\n${error.message || error}`); process.exitCode = 1; });
