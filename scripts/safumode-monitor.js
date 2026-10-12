#!/usr/bin/env node
"use strict";

// SAFUMODE is deliberately provider-only: it has no signer and performs no RPC writes.
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Interface, getAddress, keccak256 } = require("ethers");

const ABI = [
  "event TrustScheduled(address indexed account,uint256 indexed nonce,uint64 executableAt)",
  "event TrustedSet(address indexed account,bool trusted,uint256 indexed nonce)",
  "event WithdrawalExecuted(bytes32 indexed requestId,address indexed asset,address indexed to,uint256 amount)",
  "event WithdrawalScheduled(bytes32 indexed requestId,address indexed asset,address indexed to,uint256 amount,uint64 executableAt)",
  "event WithdrawalCancelled(bytes32 indexed requestId)",
  "event RecoveryExecuted(address indexed asset,address indexed recoveryRecipient,uint256 amount)",
  "event PauseSet(bool paused,uint256 indexed nonce)",
  "event RotationScheduled(address indexed authorizer,address indexed recoveryAuthorizer,uint256 indexed nonce,uint64 executableAt)",
  "event AuthoritiesRotated(address indexed authorizer,address indexed recoveryAuthorizer,uint256 indexed nonce)",
  "event RotationCancelled(uint256 indexed nonce,address indexed vetoingAuthority)"
];
const iface = new Interface(ABI);
const topics = ABI.map((x) => iface.getEvent(x.slice(6, x.indexOf("("))).topicHash);
const topicSet = new Set(topics.map((x) => x.toLowerCase()));
const json = (v) => JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x);
function fatal(message) { const e = new Error(message); e.safumode = true; throw e; }

async function emit(out, type, fields = {}) {
  const line = json({ safumode: 1, type, ...fields }) + "\n";
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = (error) => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
    try {
      const accepted = out.write(line, done);
      // A non-stream test sink may not invoke callbacks. Real Writable streams always do.
      if (out.write.length < 2) done();
      else if (!accepted && typeof out.once === "function") out.once("error", done);
    } catch (e) { done(e); }
  });
}

function parseArgs(argv) {
  const values = {}; const flags = new Set(["help", "once"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg === "--") fatal(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (Object.prototype.hasOwnProperty.call(values, key)) fatal(`duplicate option: --${key}`);
    if (flags.has(key)) values[key] = true;
    else if (["rpc", "address", "chain-id", "code-hash", "checkpoint", "start-block", "confirmations", "poll-ms", "batch-size", "reorg-depth"].includes(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) fatal(`missing value for --${key}`);
      values[key] = argv[++i];
    } else fatal(`unknown option: --${key}`);
  }
  return values;
}
function usage() {
  return `Usage: node scripts/safumode-monitor.js --rpc URL --chain-id ID --address ADDRESS --code-hash 0xHASH [options]\n\n` +
    `Requires a trusted archival RPC capable of complete blocks, receipts, and logs.\n\nOptions:\n  --checkpoint FILE       State file (default .safumode-checkpoint.json)\n` +
    `  --start-block N         First block for a new checkpoint (default latest + 1)\n  --confirmations N       Confirmation lag (default 1)\n` +
    `  --poll-ms N             Poll interval (default 5000)\n  --batch-size N          Maximum blocks per poll (default 500)\n` +
    `  --reorg-depth N         Retained block-hash window (default 128)\n  --once                  Scan available blocks and exit\n`;
}
function integer(value, name, fallback, min = 0) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || !Number.isSafeInteger(Number(value))) fatal(`invalid --${name}`);
  return Number(value);
}
function argsObject(parsed) {
  if (!parsed.rpc || !parsed.address || !parsed["chain-id"] || !parsed["code-hash"]) fatal("--rpc, --chain-id, --address and --code-hash are required");
  let address; try { address = getAddress(parsed.address); } catch (_) { fatal("invalid --address"); }
  let expectedChainId; try { expectedChainId = BigInt(parsed["chain-id"]); } catch (_) { fatal("invalid --chain-id"); }
  if (expectedChainId <= 0n || !/^\d+$/.test(parsed["chain-id"])) fatal("invalid --chain-id");
  let rpc; try { rpc = new URL(parsed.rpc); } catch (_) { fatal("invalid --rpc URL"); }
  if (!/^https?:$/.test(rpc.protocol)) fatal("--rpc must use http or https");
  const codeHash = parsed["code-hash"].toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(codeHash)) fatal("invalid --code-hash");
  return { rpc: parsed.rpc, address, expectedChainId, codeHash, checkpoint: parsed.checkpoint || ".safumode-checkpoint.json",
    startBlock: parsed["start-block"] === undefined ? null : integer(parsed["start-block"], "start-block", 0),
    confirmations: integer(parsed.confirmations, "confirmations", 1), pollMs: integer(parsed["poll-ms"], "poll-ms", 5000, 50),
    batchSize: integer(parsed["batch-size"], "batch-size", 500, 1), reorgDepth: integer(parsed["reorg-depth"], "reorg-depth", 128, 2), once: !!parsed.once };
}
function atomicSave(file, state) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`; const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeFileSync(fd, json(state) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { const dir = fs.openSync(path.dirname(path.resolve(file)), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch (_) {}
}
function loadState(file) {
  if (!fs.existsSync(file)) return null;
  let state; try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { fatal("checkpoint is unreadable or invalid"); }
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.nextBlock) || state.nextBlock < 0 || !Array.isArray(state.hashes)) fatal("checkpoint has invalid schema");
  let previous = -1;
  for (const h of state.hashes) {
    if (!h || !Number.isSafeInteger(h.number) || h.number < 0 || (previous >= 0 && h.number !== previous + 1) || h.number >= state.nextBlock || !/^0x[0-9a-fA-F]{64}$/.test(h.hash)) fatal("checkpoint has invalid hash history");
    previous = h.number;
  }
  if (state.nextBlock > 0 && (!state.hashes.length || previous !== state.nextBlock - 1)) fatal("checkpoint is missing its canonical anchor");
  return state;
}
function logKey(log) { return `${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.index}`; }

class Monitor {
  constructor(options, provider = null, out = process.stdout) {
    this.o = options; this.provider = provider || new JsonRpcProvider(options.rpc, undefined, { staticNetwork: false }); this.out = out; this.state = null; this.stopped = false; this.wake = null;
  }
  stop() { this.stopped = true; if (this.wake) this.wake(); }
  async verify() {
    const network = await this.provider.getNetwork();
    if (network.chainId !== this.o.expectedChainId) fatal(`chain ID mismatch: expected ${this.o.expectedChainId}, received ${network.chainId}`);
    const code = await this.provider.getCode(this.o.address); if (code === "0x") fatal("configured address has no contract code");
    if (keccak256(code).toLowerCase() !== this.o.codeHash) fatal(`contract code hash mismatch at ${this.o.address}`);
  }
  async initialize() {
    await this.verify(); const latest = await this.provider.getBlockNumber(); this.state = loadState(this.o.checkpoint);
    if (this.state) {
      if (this.state.chainId !== this.o.expectedChainId.toString() || this.state.address !== this.o.address || this.state.codeHash !== this.o.codeHash) fatal("checkpoint configuration mismatch");
      if (this.state.nextBlock > latest + 1) fatal("checkpoint is ahead of RPC head");
      if (this.state.hashes.length > this.o.reorgDepth) fatal("checkpoint hash history exceeds --reorg-depth");
    } else {
      const nextBlock = this.o.startBlock === null ? latest + 1 : this.o.startBlock;
      if (nextBlock > latest + 1) fatal("--start-block is ahead of RPC head");
      const hashes = [];
      if (nextBlock > 0) { const anchor = await this.provider.getBlock(nextBlock - 1); if (!anchor) fatal("RPC omitted startup anchor block"); hashes.push({ number: nextBlock - 1, hash: anchor.hash }); }
      this.state = { version: 1, chainId: this.o.expectedChainId.toString(), address: this.o.address, codeHash: this.o.codeHash, nextBlock, hashes };
      atomicSave(this.o.checkpoint, this.state);
    }
    await this.checkReorg();
  }
  async checkReorg() {
    if (!this.state.hashes.length) return;
    let ancestor = -1;
    for (let i = this.state.hashes.length - 1; i >= 0; i--) {
      const saved = this.state.hashes[i], block = await this.provider.getBlock(saved.number);
      if (block && block.hash.toLowerCase() === saved.hash.toLowerCase()) { ancestor = i; break; }
    }
    if (ancestor === this.state.hashes.length - 1) return;
    const rewindTo = ancestor < 0 ? Math.max(0, this.state.nextBlock - this.o.reorgDepth) : this.state.hashes[ancestor].number + 1;
    await emit(this.out, "rpc_reorg", { severity: "critical", previousNextBlock: this.state.nextBlock, rewindTo });
    if (ancestor < 0) fatal("reorg exceeds retained checkpoint history; operator intervention required");
    this.state.hashes = this.state.hashes.slice(0, ancestor + 1); this.state.nextBlock = rewindTo; atomicSave(this.o.checkpoint, this.state);
  }
  async verifiedLogs(number) {
    const before = await this.provider.getBlock(number); if (!before) fatal(`RPC omitted block ${number}`);
    const queried = await this.provider.getLogs({ address: this.o.address, fromBlock: number, toBlock: number, topics: [topics] });
    const expected = [];
    for (const tx of before.transactions) {
      const hash = typeof tx === "string" ? tx : tx.hash;
      const receipt = await this.provider.getTransactionReceipt(hash); if (!receipt) fatal(`RPC omitted receipt in block ${number}`);
      const receiptHash = receipt.hash || receipt.transactionHash;
      if (!receiptHash || receiptHash.toLowerCase() !== hash.toLowerCase()) fatal(`RPC returned receipt for wrong transaction in block ${number}`);
      if (receipt.blockNumber !== number || receipt.blockHash.toLowerCase() !== before.hash.toLowerCase()) fatal(`RPC returned inconsistent receipt in block ${number}`);
      for (const log of receipt.logs) if (log.address.toLowerCase() === this.o.address.toLowerCase() && log.topics[0] && topicSet.has(log.topics[0].toLowerCase())) expected.push(log);
    }
    const after = await this.provider.getBlock(number); if (!after || after.hash.toLowerCase() !== before.hash.toLowerCase()) fatal(`block ${number} changed during scan`);
    for (const log of queried) if (log.blockNumber !== number || log.blockHash.toLowerCase() !== before.hash.toLowerCase()) fatal(`RPC returned log/header mismatch in block ${number}`);
    const a = queried.map(logKey).sort(), b = expected.map(logKey).sort();
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) fatal(`RPC log/receipt inconsistency in block ${number}`);
    return { block: after, logs: queried.sort((x, y) => x.index - y.index) };
  }
  async scanOnce(fixedTarget = null) {
    await this.verify(); await this.checkReorg();
    const latest = await this.provider.getBlockNumber();
    const available = fixedTarget === null ? latest - this.o.confirmations : Math.min(fixedTarget, latest - this.o.confirmations);
    const target = Math.min(available, this.state.nextBlock + this.o.batchSize - 1);
    let processed = 0;
    while (!this.stopped && this.state.nextBlock <= target) {
      const number = this.state.nextBlock, { block, logs } = await this.verifiedLogs(number);
      for (const log of logs) {
        let parsed; try { parsed = iface.parseLog(log); } catch (_) { fatal("received undecodable monitored event"); }
        const args = {}; parsed.fragment.inputs.forEach((input, i) => { args[input.name] = parsed.args[i]; });
        await emit(this.out, "vault_event", { severity: "critical", event: parsed.name, chainId: this.o.expectedChainId, address: this.o.address, blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.index, args });
      }
      this.state.hashes.push({ number, hash: block.hash }); if (this.state.hashes.length > this.o.reorgDepth) this.state.hashes.shift();
      this.state.nextBlock = number + 1; atomicSave(this.o.checkpoint, this.state); processed++;
    }
    return processed;
  }
  async run() {
    await this.initialize();
    if (this.o.once) {
      const target = (await this.provider.getBlockNumber()) - this.o.confirmations;
      while (!this.stopped && this.state.nextBlock <= target) await this.scanOnce(target);
      return;
    }
    do {
      await this.scanOnce(); if (this.stopped) break;
      await new Promise((resolve) => { const timer = setTimeout(resolve, this.o.pollMs); this.wake = () => { clearTimeout(timer); resolve(); }; }); this.wake = null;
    } while (!this.stopped);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2)); if (parsed.help) { process.stdout.write(usage()); return; }
  const options = argsObject(parsed), monitor = new Monitor(options);
  const stop = () => monitor.stop(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await monitor.run(); } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); monitor.provider.destroy(); }
}
if (require.main === module) main().catch(async (e) => { try { await emit(process.stderr, "monitor_failure", { severity: "critical", error: e.safumode ? e.message : "RPC or internal monitoring failure" }); } finally { process.exitCode = 1; } });
module.exports = { Monitor, parseArgs, argsObject, iface };
