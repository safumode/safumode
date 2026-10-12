#!/usr/bin/env node
"use strict";
const fs = require("fs");
const { ethers } = require("ethers");
const { canonical, digest, prepare, relay } = require("./safumode-tx");

const PREPARE_ACTIONS = "schedule|withdraw|recover|trust|cancel|pause|rotate|cancel-rotation";

function args(argv) {
  const out = { _: [] };
  for (let i=0;i<argv.length;i++) {
    if (!argv[i].startsWith("--")) out._.push(argv[i]);
    else { const k=argv[i].slice(2); out[k] = argv[i+1] && !argv[i+1].startsWith("--") ? argv[++i] : true; }
  }
  return out;
}
function jsonFile(path, label) { if (!path) throw new Error(`--${label} is required`); return JSON.parse(fs.readFileSync(path,"utf8")); }
function relayerIndex(value) {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("--relayer-index must be a non-negative decimal integer");
  const index=Number(value);
  if (!Number.isSafeInteger(index)) throw new Error("--relayer-index is too large");
  return index;
}
async function main() {
  const a=args(process.argv.slice(2)), command=a._[0];
  if (command === "prepare") {
    if (!a.action) throw new Error("--action is required");
    const bundle=prepare(a.manifest, a.action, jsonFile(a.input,"input"), {version:a.version});
    process.stdout.write(canonical(bundle));
    return;
  }
  if (command === "relay") {
    const bundle=jsonFile(a.bundle,"bundle"), signatures=jsonFile(a.signatures,"signatures");
    if (!a.rpc) throw new Error("--rpc is required for chain/domain/nonce verification");
    const provider=new ethers.JsonRpcProvider(a.rpc);
    // Broadcast is an explicit opt-in and remains hard-limited by the library to local chain 31337 + loopback RPC.
    if (a.broadcast && !a.relayer) throw new Error("--relayer is required with --broadcast");
    const index=relayerIndex(a["relayer-index"]);
    const relayer=a.broadcast ? await provider.getSigner(index) : null;
    const result=await relay(bundle,a.manifest,signatures,provider,relayer,{rpcUrl:a.rpc,relayerAddress:a.relayer,dryRun:!a.broadcast});
    process.stdout.write(canonical({...result,digest:digest(bundle)}));
    return;
  }
  throw new Error(`usage: safumode-cli.js prepare --manifest FILE --action ${PREPARE_ACTIONS} --input FILE [--version 1:N]\n       safumode-cli.js relay --manifest FILE --bundle FILE --signatures FILE --rpc URL [--broadcast --relayer ADDRESS --relayer-index N]`);
}
if (require.main === module) main().catch(e=>{ console.error(`SAFUMODE: ${e.message}`); process.exitCode=1; });
module.exports = { args, main, relayerIndex, PREPARE_ACTIONS };
