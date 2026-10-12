#!/usr/bin/env node
"use strict";

// Offline operator tool. It never opens an RPC connection and never modifies the journal.
const fs = require("fs");
const path = require("path");
const { getAddress } = require("ethers");

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 10000;
const MAX_OUTPUT = 1000;
const json = (value) => JSON.stringify(value);
function fatal(message) { const error = new Error(message); error.safumode = true; throw error; }

function identityFromArgs(chainId, address) {
  if (!/^\d+$/.test(chainId || "") || BigInt(chainId) <= 0n || BigInt(chainId).toString() !== chainId) fatal("invalid --chain-id (use canonical decimal form)");
  let normalized;
  try { normalized = getAddress(address); } catch (_) { fatal("invalid --address"); }
  // Requiring the canonical checksum spelling prevents an operator typo/case mismatch
  // from being silently normalized while acknowledging security evidence.
  if (address !== normalized) fatal(`--address must use exact checksum form: ${normalized}`);
  return { chainId, address };
}

function safeRegular(file, label, required = true) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (!required && error.code === "ENOENT") return null;
    if (error.code === "ENOENT") fatal(`${label} does not exist`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fatal(`${label} must be a regular file, not a symlink`);
  if (stat.size > MAX_FILE_BYTES) fatal(`${label} exceeds size limit`);
  return stat;
}

function readSafe(file, label, required = true) {
  if (!safeRegular(file, label, required)) return null;
  const nofollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | nofollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fatal(`${label} must be a regular file, not a symlink`);
    if (stat.size > MAX_FILE_BYTES) fatal(`${label} exceeds size limit`);
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

function rejectSameFile(journalFile, ackFile) {
  const journal = safeRegular(journalFile, "alert journal");
  const acks = safeRegular(ackFile, "acknowledgement file", false);
  if (acks && journal.dev === acks.dev && journal.ino === acks.ino) {
    fatal("journal and acknowledgement files must not be the same file or hardlinks");
  }
}

function withAckLock(file, operation) {
  const dirName = path.dirname(path.resolve(file));
  fs.mkdirSync(dirName, { recursive: true, mode: 0o700 });
  const lockFile = `${file}.lock`;
  const nofollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  let owner;
  try {
    try {
      fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | nofollow, 0o600);
    } catch (error) {
      if (error.code === "EEXIST") fatal("acknowledgement file is busy (owner lock exists)");
      throw error;
    }
    owner = fs.fstatSync(fd);
    fs.writeFileSync(fd, json({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n");
    fs.fsyncSync(fd);
    return operation();
  } finally {
    // Never remove a lock that was replaced while this process was running.
    if (fd !== undefined) {
      try {
        const current = fs.lstatSync(lockFile);
        if (owner && current.dev === owner.dev && current.ino === owner.ino) fs.unlinkSync(lockFile);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      } finally {
        fs.closeSync(fd);
      }
    }
  }
}

function readJournal(file, expected) {
  const contents = readSafe(file, "alert journal");
  if (!contents.endsWith("\n")) fatal("alert journal has a torn or unterminated record");
  const lines = contents.slice(0, -1).split("\n");
  if (!lines[0]) fatal("alert journal is unreadable or invalid");
  let header;
  try { header = JSON.parse(lines.shift()); } catch (_) { fatal("alert journal is unreadable or invalid"); }
  if (!header || header.safumodeJournal !== 1 || !header.identity || header.identity.chainId !== expected.chainId || header.identity.address !== expected.address) fatal("alert journal chain/address identity mismatch");
  if (lines.length > MAX_RECORDS) fatal("alert journal record limit exceeded");
  const records = new Map();
  for (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch (_) { fatal("alert journal contains invalid JSON"); }
    if (!item || typeof item.id !== "string" || !item.id || !item.record || item.record.safumode !== 1) fatal("alert journal contains an invalid record");
    if (records.has(item.id)) {
      if (json(records.get(item.id).record) !== json(item.record)) fatal("alert journal contains a conflicting duplicate ID");
      continue;
    }
    records.set(item.id, item);
  }
  return { identity: header.identity, records };
}

function readAcks(file, identity) {
  const contents = readSafe(file, "acknowledgement file", false);
  if (contents === null) return { version: 1, identity, acknowledged: [] };
  let state;
  try { state = JSON.parse(contents); } catch (_) { fatal("acknowledgement file is unreadable or invalid"); }
  if (!state || state.version !== 1 || !state.identity || json(state.identity) !== json(identity) || !Array.isArray(state.acknowledged) || state.acknowledged.length > MAX_RECORDS) fatal("acknowledgement file has invalid schema or identity mismatch");
  const ids = new Set();
  for (const item of state.acknowledged) {
    if (!item || typeof item.id !== "string" || !item.id || typeof item.acknowledgedAt !== "string" || ids.has(item.id)) fatal("acknowledgement file has invalid or duplicate records");
    ids.add(item.id);
  }
  return state;
}

function atomicSave(file, state) {
  const dirName = path.dirname(path.resolve(file));
  fs.mkdirSync(dirName, { recursive: true, mode: 0o700 });
  safeRegular(file, "acknowledgement file", false);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const nofollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | nofollow, 0o600);
    fs.writeFileSync(fd, json(state) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
    const dir = fs.openSync(dirName, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function inspect(options) {
  const expected = identityFromArgs(options.chainId, options.address);
  rejectSameFile(options.journal, options.acks);
  const journal = readJournal(options.journal, expected);
  const acks = readAcks(options.acks, journal.identity);
  const acknowledged = new Set(acks.acknowledged.map((x) => x.id));
  return [...journal.records.values()].slice(-options.limit).map((item) => ({ ...item, acknowledged: acknowledged.has(item.id) }));
}

function acknowledge(options, now = () => new Date().toISOString()) {
  const expected = identityFromArgs(options.chainId, options.address);
  return withAckLock(options.acks, () => {
    rejectSameFile(options.journal, options.acks);
    const journal = readJournal(options.journal, expected);
    if (!journal.records.has(options.id)) fatal("alert ID is not present in the journal");
    const state = readAcks(options.acks, journal.identity);
    const existing = state.acknowledged.find((item) => item.id === options.id);
    if (existing) return { ...existing, alreadyAcknowledged: true };
    if (state.acknowledged.length >= MAX_RECORDS) fatal("acknowledgement record limit reached");
    const item = { id: options.id, acknowledgedAt: now() };
    atomicSave(options.acks, { ...state, acknowledged: [...state.acknowledged, item] });
    return { ...item, alreadyAcknowledged: false };
  });
}

function parseArgs(argv) {
  const command = argv.shift();
  if (!command || !["inspect", "acknowledge"].includes(command)) fatal("usage: safumode-alerts <inspect|acknowledge> --journal FILE --chain-id ID --address ADDRESS [--acks FILE] [--limit N|--id ID]");
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--") || !argv[i + 1] || argv[i + 1].startsWith("--")) fatal(`invalid argument: ${arg}`);
    const key = arg.slice(2);
    if (!["journal", "chain-id", "address", "acks", "limit", "id"].includes(key) || values[key] !== undefined) fatal(`invalid or duplicate option: ${arg}`);
    values[key] = argv[++i];
  }
  if (!values.journal || !values["chain-id"] || !values.address) fatal("--journal, --chain-id and --address are required");
  const options = { journal: values.journal, acks: values.acks || `${values.journal}.acks.json`, chainId: values["chain-id"], address: values.address };
  if (path.resolve(options.journal) === path.resolve(options.acks)) fatal("journal and acknowledgement files must differ");
  if (command === "inspect") {
    if (values.id) fatal("--id is only valid for acknowledge");
    const limit = values.limit === undefined ? 100 : Number(values.limit);
    if (!/^\d+$/.test(values.limit === undefined ? "100" : values.limit) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OUTPUT) fatal(`--limit must be between 1 and ${MAX_OUTPUT}`);
    return { command, options: { ...options, limit } };
  }
  if (!values.id || values.limit) fatal("acknowledge requires --id and does not accept --limit");
  return { command, options: { ...options, id: values.id } };
}

function main(argv = process.argv.slice(2), out = process.stdout) {
  const parsed = parseArgs([...argv]);
  const result = parsed.command === "inspect" ? inspect(parsed.options) : acknowledge(parsed.options);
  out.write(json(result) + "\n");
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.safumode ? error.message : "internal alert journal error"}\n`); process.exitCode = 1; } }
module.exports = { readJournal, readAcks, inspect, acknowledge, parseArgs, main, MAX_FILE_BYTES, MAX_RECORDS };
