#!/usr/bin/env node
"use strict";

// SAFUMODE is deliberately provider-only: it has no signer and performs no RPC writes.
const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");
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
const DEFAULT_SPOOL_MAX_BYTES = 16 * 1024 * 1024;
const MAX_SPOOL_RECORDS = 10000;
function fatal(message) { const e = new Error(message); e.safumode = true; throw e; }

async function emit(out, type, fields = {}) { return writeRecord(out, { safumode: 1, type, ...fields }); }
async function writeRecord(out, record) {
  const line = json(record) + "\n";
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
    else if (["rpc", "address", "chain-id", "code-hash", "checkpoint", "spool", "journal", "spool-max-bytes", "start-block", "confirmations", "poll-ms", "batch-size", "reorg-depth"].includes(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) fatal(`missing value for --${key}`);
      values[key] = argv[++i];
    } else fatal(`unknown option: --${key}`);
  }
  return values;
}
function usage() {
  return `Usage: node scripts/safumode-monitor.js --rpc URL --chain-id ID --address ADDRESS --code-hash 0xHASH [options]\n\n` +
    `Requires a trusted archival RPC capable of complete blocks, receipts, and logs.\n\nOptions:\n  --checkpoint FILE       State file (default .safumode-checkpoint.json)\n` +
    `  --spool FILE            Durable pending-alert file (default CHECKPOINT.alerts.json)\n  --journal FILE          Append-only delivered-alert journal (default CHECKPOINT.alerts.jsonl)\n  --spool-max-bytes N     Maximum serialized spool size (default 16777216)\n` +
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
  const checkpoint = parsed.checkpoint || ".safumode-checkpoint.json";
  const spool = parsed.spool || `${checkpoint}.alerts.json`;
  const journal = parsed.journal || `${checkpoint}.alerts.jsonl`;
  const files = [checkpoint, spool, journal].map((x) => path.resolve(x));
  if (new Set(files).size !== files.length) fatal("--checkpoint, --spool and --journal must be different files");
  return { rpc: parsed.rpc, address, expectedChainId, codeHash, checkpoint,
    spool, journal, spoolMaxBytes: integer(parsed["spool-max-bytes"], "spool-max-bytes", DEFAULT_SPOOL_MAX_BYTES, 1024),
    startBlock: parsed["start-block"] === undefined ? null : integer(parsed["start-block"], "start-block", 0),
    confirmations: integer(parsed.confirmations, "confirmations", 1), pollMs: integer(parsed["poll-ms"], "poll-ms", 5000, 50),
    batchSize: integer(parsed["batch-size"], "batch-size", 500, 1), reorgDepth: integer(parsed["reorg-depth"], "reorg-depth", 128, 2), once: !!parsed.once };
}
function atomicSave(file, state) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  // A predictable "pid.tmp" opened with "w" follows attacker-supplied symlinks.
  const tmp = `${file}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(tmp, flags, 0o600);
  const owner = fs.fstatSync(fd);
  let closed = false, renamed = false;
  try {
    fs.writeFileSync(fd, json(state) + "\n"); fs.fsyncSync(fd);
    fs.closeSync(fd); closed = true;
    fs.renameSync(tmp, file); renamed = true;
  } finally {
    if (!closed) fs.closeSync(fd);
    if (!renamed) {
      try {
        const current = fs.lstatSync(tmp);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === owner.dev && current.ino === owner.ino) fs.unlinkSync(tmp);
      } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
  }
  const dir = fs.openSync(path.dirname(path.resolve(file)), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function assertSafeFile(file, label) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fatal(`${label} must be a regular file, not a symlink`);
}
class MonitorLock {
  constructor(checkpoint) { this.file = `${path.resolve(checkpoint)}.lock`; this.fd = null; this.identity = null; }
  acquire() {
    const dirName = path.dirname(this.file);
    fs.mkdirSync(dirName, { recursive: true, mode: 0o700 });
    const nofollow = fs.constants.O_NOFOLLOW || 0;
    try { this.fd = fs.openSync(this.file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | nofollow, 0o600); }
    catch (e) {
      if (e && (e.code === "EEXIST" || e.code === "ELOOP")) fatal(`monitor lock already exists: ${this.file}; verify the previous monitor has stopped before manual removal`);
      throw e;
    }
    try {
      const stat = fs.fstatSync(this.fd);
      if (!stat.isFile()) fatal("monitor lock is not a regular file");
      this.identity = { dev: stat.dev, ino: stat.ino };
      fs.writeFileSync(this.fd, json({ safumodeLock: 1, pid: process.pid, startedAt: new Date().toISOString(), checkpoint: path.resolve(this.file.slice(0, -5)) }) + "\n");
      fs.fsyncSync(this.fd);
      const dir = fs.openSync(dirName, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch (e) { this.release(); throw e; }
  }
  release() {
    if (this.fd === null) return;
    try {
      // Remove only the directory entry that still names this owner's inode.
      // A swapped path or symlink is left in place rather than deleted.
      let stat = null;
      try { stat = fs.lstatSync(this.file); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (stat && !stat.isSymbolicLink() && stat.isFile() && stat.dev === this.identity.dev && stat.ino === this.identity.ino) {
        fs.unlinkSync(this.file);
        const dir = fs.openSync(path.dirname(this.file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
    } finally { fs.closeSync(this.fd); this.fd = null; this.identity = null; }
  }
}
class AlertSpool {
  constructor(file, identity, maxBytes = DEFAULT_SPOOL_MAX_BYTES) { this.file = file; this.identity = identity; this.maxBytes = maxBytes; this.state = null; }
  open() {
    assertSafeFile(this.file, "alert spool");
    if (fs.existsSync(this.file)) {
      if (fs.statSync(this.file).size > this.maxBytes) fatal("alert spool exceeds configured size limit");
      try { this.state = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (_) { fatal("alert spool is unreadable or invalid"); }
      if (!this.state || this.state.version !== 1 || json(this.state.identity) !== json(this.identity) || !Array.isArray(this.state.pending)) fatal("alert spool has invalid schema or configuration identity mismatch");
      const ids = new Set(); let invalid = this.state.pending.length > MAX_SPOOL_RECORDS;
      for (const item of this.state.pending) {
        if (!item || typeof item.id !== "string" || !item.id || !item.record || item.record.safumode !== 1 || ids.has(item.id)) { invalid = true; break; }
        ids.add(item.id);
      }
      if (invalid) fatal("alert spool has invalid or duplicate pending records");
      fs.chmodSync(this.file, 0o600);
    } else { this.state = { version: 1, identity: this.identity, pending: [] }; this.save(); }
  }
  save(candidate = this.state) {
    assertSafeFile(this.file, "alert spool");
    if (Buffer.byteLength(json(candidate) + "\n") > this.maxBytes) fatal("alert spool size limit reached; operator action required");
    atomicSave(this.file, candidate); fs.chmodSync(this.file, 0o600);
  }
  enqueue(id, record) {
    const existing = this.state.pending.find((x) => x.id === id);
    if (existing) {
      if (json(existing.record) !== json(record)) fatal("alert spool ID conflicts with an existing record");
      return;
    }
    if (this.state.pending.length >= MAX_SPOOL_RECORDS) fatal("alert spool record limit reached; operator action required");
    const candidate = { ...this.state, pending: [...this.state.pending, { id, record }] }; this.save(candidate); this.state = candidate;
  }
  acknowledge(id) {
    const candidate = { ...this.state, pending: this.state.pending.filter((x) => x.id !== id) }; this.save(candidate); this.state = candidate;
  }
}
class AlertJournal {
  constructor(file, identity, faults = {}) { this.file = file; this.identity = identity; this.records = new Map(); this.faults = faults; }
  open() {
    const dirName = path.dirname(path.resolve(this.file));
    fs.mkdirSync(dirName, { recursive: true, mode: 0o700 });
    assertSafeFile(this.file, "alert journal");
    if (!fs.existsSync(this.file)) {
      const fd = fs.openSync(this.file, "wx", 0o600);
      try { fs.writeFileSync(fd, json({ safumodeJournal: 1, identity: this.identity }) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const dir = fs.openSync(dirName, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    assertSafeFile(this.file, "alert journal");
    const nofollow = fs.constants.O_NOFOLLOW || 0;
    let contents;
    const fd = fs.openSync(this.file, fs.constants.O_RDWR | nofollow);
    try {
      // Use the same descriptor for validation, recovery, and reading so a
      // path swap cannot make the lstat above apply to a different object.
      if (!fs.fstatSync(fd).isFile()) fatal("alert journal must be a regular file, not a symlink");
      contents = fs.readFileSync(fd, "utf8");
      if (!contents.endsWith("\n")) {
        // An append interrupted before fsync can leave only the final JSONL
        // record torn. Complete newline-terminated records remain committed;
        // the corresponding spool item (if any) is replayed below startup.
        const committedBytes = contents.lastIndexOf("\n") + 1;
        if (committedBytes === 0) fatal("alert journal is unreadable or invalid");
        fs.ftruncateSync(fd, Buffer.byteLength(contents.slice(0, committedBytes), "utf8"));
        fs.fsyncSync(fd);
        contents = contents.slice(0, committedBytes);
      }
      fs.fchmodSync(fd, 0o600);
    } finally { fs.closeSync(fd); }
    const lines = contents.split("\n");
    lines.pop();
    let header;
    try { header = JSON.parse(lines.shift()); } catch (_) { fatal("alert journal is unreadable or invalid"); }
    if (!header || header.safumodeJournal !== 1 || json(header.identity) !== json(this.identity)) fatal("alert journal has invalid schema or configuration identity mismatch");
    for (const line of lines) {
      let item; try { item = JSON.parse(line); } catch (_) { fatal("alert journal is unreadable or invalid"); }
      if (!item || typeof item.id !== "string" || !item.id || !item.record || item.record.safumode !== 1) fatal("alert journal has invalid records");
      if (this.records.has(item.id) && json(this.records.get(item.id)) !== json(item.record)) fatal("alert journal contains a conflicting duplicate ID");
      this.records.set(item.id, item.record);
    }
  }
  append(id, record) {
    if (this.records.has(id)) {
      if (json(this.records.get(id)) !== json(record)) fatal("alert journal ID conflicts with an existing record");
      return;
    }
    assertSafeFile(this.file, "alert journal");
    const nofollow = fs.constants.O_NOFOLLOW || 0;
    const fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | nofollow);
    try {
      fs.writeFileSync(fd, json({ id, record }) + "\n");
      if (this.faults.journalBeforeFsync) this.faults.journalBeforeFsync(id, record);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    this.records.set(id, record);
  }
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
  constructor(options, provider = null, out = process.stdout, faults = {}) {
    this.o = options; this.provider = provider || new JsonRpcProvider(options.rpc, undefined, { staticNetwork: false }); this.out = out; this.state = null; this.stopped = false; this.wake = null; this.faults = faults;
    const identity = { chainId: options.expectedChainId.toString(), address: options.address, codeHash: options.codeHash };
    this.spool = new AlertSpool(options.spool || `${options.checkpoint}.alerts.json`, identity, options.spoolMaxBytes || DEFAULT_SPOOL_MAX_BYTES);
    this.journal = new AlertJournal(options.journal || `${options.checkpoint}.alerts.jsonl`, identity, faults);
    this.lock = new MonitorLock(options.checkpoint);
  }
  stop() { this.stopped = true; if (this.wake) this.wake(); }
  async verify() {
    const network = await this.provider.getNetwork();
    if (network.chainId !== this.o.expectedChainId) fatal(`chain ID mismatch: expected ${this.o.expectedChainId}, received ${network.chainId}`);
    const code = await this.provider.getCode(this.o.address); if (code === "0x") fatal("configured address has no contract code");
    if (keccak256(code).toLowerCase() !== this.o.codeHash) fatal(`contract code hash mismatch at ${this.o.address}`);
  }
  async initialize() {
    await this.verify(); const latest = await this.provider.getBlockNumber(); this.state = loadState(this.o.checkpoint); this.spool.open(); this.journal.open();
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
    await this.replayPending(); await this.checkReorg();
  }
  async replayPending() {
    for (const item of [...this.spool.state.pending]) {
      await writeRecord(this.out, item.record);
      this.journal.append(item.id, item.record);
      this.spool.acknowledge(item.id);
    }
  }
  async durableAlert(id, type, fields) {
    const record = { safumode: 1, type, ...fields };
    // A replayed spool item can belong to the block that the unchanged
    // checkpoint is about to scan again. Its journal entry proves this exact
    // alert was already emitted, so do not emit it a second time.
    if (this.journal.records.has(id)) {
      if (json(this.journal.records.get(id)) !== json(record)) fatal("alert journal ID conflicts with an existing record");
      return;
    }
    this.spool.enqueue(id, record);
    if (this.faults.afterSpool) await this.faults.afterSpool(id, record);
    await writeRecord(this.out, record);
    // Preserve a local durable copy before removing the retry copy. Stdout's
    // callback does not mean a downstream consumer durably received the line.
    this.journal.append(id, record);
    this.spool.acknowledge(id);
  }
  async checkReorg() {
    if (!this.state.hashes.length) return;
    let ancestor = -1; const observed = new Map();
    for (let i = this.state.hashes.length - 1; i >= 0; i--) {
      const saved = this.state.hashes[i], block = await this.provider.getBlock(saved.number);
      observed.set(saved.number, block && block.hash ? block.hash.toLowerCase() : null);
      if (block && block.hash.toLowerCase() === saved.hash.toLowerCase()) { ancestor = i; break; }
    }
    if (ancestor === this.state.hashes.length - 1) return;
    const rewindTo = ancestor < 0 ? Math.max(0, this.state.nextBlock - this.o.reorgDepth) : this.state.hashes[ancestor].number + 1;
    // Coordinates alone are not an event identity: after recovering, the same
    // range can reorg again onto a third fork. Bind the durable ID to the first
    // displaced canonical hash and its replacement so each distinct fork
    // transition alerts once, while a restart remains idempotent.
    // Every entry after the ancestor was observed above. Select by ancestry,
    // rather than coordinates, and use that same provider observation for the
    // evidence so a changing RPC response cannot produce a mismatched ID.
    const displaced = this.state.hashes[ancestor + 1];
    const previousBlockHash = displaced.hash.toLowerCase();
    const replacementBlockHash = observed.get(displaced.number);
    const evidence = `${displaced.number}:${previousBlockHash}:${replacementBlockHash || "missing"}`;
    await this.durableAlert(`reorg:${this.state.nextBlock}:${rewindTo}:${evidence}`, "rpc_reorg", {
      severity: "critical", previousNextBlock: this.state.nextBlock, rewindTo,
      evidenceBlock: displaced.number, previousBlockHash, replacementBlockHash
    });
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
        await this.durableAlert(`log:${logKey(log)}`, "vault_event", { severity: "critical", event: parsed.name, chainId: this.o.expectedChainId, address: this.o.address, blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.index, args });
      }
      this.state.hashes.push({ number, hash: block.hash }); if (this.state.hashes.length > this.o.reorgDepth) this.state.hashes.shift();
      this.state.nextBlock = number + 1; atomicSave(this.o.checkpoint, this.state); processed++;
    }
    return processed;
  }
  async runLocked() {
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
  async run() {
    this.lock.acquire();
    try { await this.runLocked(); }
    finally { this.lock.release(); }
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2)); if (parsed.help) { process.stdout.write(usage()); return; }
  const options = argsObject(parsed), monitor = new Monitor(options);
  const stop = () => monitor.stop(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await monitor.run(); } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); monitor.provider.destroy(); }
}
if (require.main === module) main().catch(async (e) => { try { await emit(process.stderr, "monitor_failure", { severity: "critical", error: e.safumode ? e.message : "RPC or internal monitoring failure" }); } finally { process.exitCode = 1; } });
module.exports = { Monitor, MonitorLock, AlertSpool, AlertJournal, parseArgs, argsObject, iface };
