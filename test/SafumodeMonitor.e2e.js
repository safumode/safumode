const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Monitor } = require("../scripts/safumode-monitor");

const withdrawTypes = { Withdraw: [
  { name: "asset", type: "address" }, { name: "to", type: "address" },
  { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" }, { name: "immediate", type: "bool" },
] };
class Capture { constructor() { this.text = ""; } write(s) { this.text += s; } records() { return this.text.trim() ? this.text.trim().split("\n").map(JSON.parse) : []; } }
class FaultProvider {
  constructor(base, fault) { this.base = base; this.fault = fault; this.afterLogs = null; }
  getNetwork() { return this.base.getNetwork(); }
  getCode(a) { return this.base.getCode(a); }
  getBlockNumber() { return this.base.getBlockNumber(); }
  async getTransactionReceipt(h) {
    const receipt = await this.base.getTransactionReceipt(h);
    if (this.fault === "wrong-receipt" && receipt.logs.some((log) => log.address)) {
      return { ...receipt, hash: `0x${"cd".repeat(32)}`, transactionHash: `0x${"cd".repeat(32)}`, logs: [] };
    }
    return receipt;
  }
  async getLogs(filter) { const logs = await this.base.getLogs(filter); if (this.fault === "omit" || this.fault === "wrong-receipt") return []; if (this.fault === "race") this.afterLogs = filter.fromBlock; return logs; }
  async getBlock(n) { const block = await this.base.getBlock(n); if (this.fault === "race" && this.afterLogs === n) { this.afterLogs = null; return { ...block, hash: `0x${"ab".repeat(32)}` }; } return block; }
}
class ReorgProvider extends FaultProvider {
  constructor(base, number, hash) { super(base, null); this.number = number; this.hash = hash; }
  async getBlock(n) {
    const block = await this.base.getBlock(n);
    if (n !== this.number || !block) return block;
    return new Proxy(block, { get: (target, property) => property === "hash" ? this.hash : Reflect.get(target, property, target) });
  }
}

async function fixture(amount = 42, nonce = 11) {
  const [, authorizer, recovery, recipient, destination] = await ethers.getSigners();
  const vault = await ethers.deployContract("AuthorizationVault", [authorizer.address, recovery.address, recipient.address, 3600]);
  await vault.waitForDeployment();
  const address = await vault.getAddress(), eventBlock = await ethers.provider.getBlockNumber() + 1;
  const deadline = (await ethers.provider.getBlock("latest")).timestamp + 10000;
  const value = { asset: ethers.ZeroAddress, to: destination.address, amount, nonce, deadline, immediate: false };
  const domain = { name: "Authorization Vault Prototype", version: await vault.VERSION(), chainId: 31337, verifyingContract: address };
  await (await vault.scheduleWithdrawal(value.asset, value.to, value.amount, value.nonce, deadline, await authorizer.signTypedData(domain, withdrawTypes, value))).wait();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safumode-e2e-")), checkpoint = path.join(dir, "checkpoint.json");
  const options = { rpc: "unused", address, expectedChainId: 31337n, codeHash: ethers.keccak256(await ethers.provider.getCode(address)).toLowerCase(), checkpoint, startBlock: eventBlock, confirmations: 0, pollMs: 50, batchSize: 50, reorgDepth: 8, once: true };
  return { address, eventBlock, dir, checkpoint, options };
}

async function rejectedRun(options, provider, out = new Capture()) {
  try { await new Monitor(options, provider, out).run(); } catch (e) { return e; }
  throw new Error("expected monitor failure");
}
async function rejectedRunWithFaults(options, provider, out, faults) {
  try { await new Monitor(options, provider, out, faults).run(); } catch (e) { return e; }
  throw new Error("expected monitor failure");
}

describe("SAFUMODE monitor e2e (ephemeral Hardhat chain)", function () {
  it("alerts, resumes without duplicates, and fails closed on chain mismatch", async function () {
    const f = await fixture(); const first = new Capture(); await new Monitor(f.options, ethers.provider, first).run();
    const alert = first.records().find((r) => r.event === "WithdrawalScheduled");
    expect(alert).to.include({ type: "vault_event", severity: "critical", address: f.address }); expect(alert.args.amount).to.equal("42");
    const second = new Capture(); await new Monitor(f.options, ethers.provider, second).run(); expect(second.records()).to.deep.equal([]);
    expect(JSON.parse(fs.readFileSync(f.checkpoint)).hashes.length).to.be.at.most(8);
    const error = await rejectedRun({ ...f.options, expectedChainId: 56n, checkpoint: path.join(f.dir, "wrong.json") }, ethers.provider);
    expect(error.message).to.match(/chain ID mismatch/); fs.rmSync(f.dir, { recursive: true, force: true });
  });

  it("fails closed on omitted logs and retries after restart", async function () {
    const f = await fixture(7, 91); const error = await rejectedRun(f.options, new FaultProvider(ethers.provider, "omit"));
    expect(error.message).to.match(/log\/receipt inconsistency/); expect(JSON.parse(fs.readFileSync(f.checkpoint)).nextBlock).to.equal(f.eventBlock);
    const capture = new Capture(); await new Monitor(f.options, ethers.provider, capture).run();
    expect(capture.records().some((r) => r.event === "WithdrawalScheduled")).to.equal(true); fs.rmSync(f.dir, { recursive: true, force: true });
  });

  it("rejects a receipt that does not belong to the requested block transaction", async function () {
    const f = await fixture(17, 95); const error = await rejectedRun(f.options, new FaultProvider(ethers.provider, "wrong-receipt"));
    expect(error.message).to.match(/receipt for wrong transaction/);
    expect(JSON.parse(fs.readFileSync(f.checkpoint)).nextBlock).to.equal(f.eventBlock);
    const capture = new Capture(); await new Monitor(f.options, ethers.provider, capture).run();
    expect(capture.records().filter((r) => r.event === "WithdrawalScheduled")).to.have.length(1); fs.rmSync(f.dir, { recursive: true, force: true });
  });

  it("detects a log/header reorg race and retries after restart", async function () {
    const f = await fixture(8, 92); const error = await rejectedRun(f.options, new FaultProvider(ethers.provider, "race"));
    expect(error.message).to.match(/changed during scan/); expect(JSON.parse(fs.readFileSync(f.checkpoint)).nextBlock).to.equal(f.eventBlock);
    const capture = new Capture(); await new Monitor(f.options, ethers.provider, capture).run();
    expect(capture.records().filter((r) => r.event === "WithdrawalScheduled")).to.have.length(1); fs.rmSync(f.dir, { recursive: true, force: true });
  });

  it("alerts for two distinct reorgs at the same coordinates and is restart-idempotent", async function () {
    const f = await fixture(12, 105);
    await ethers.provider.send("evm_mine", []); // Empty evidence block keeps the synthetic forks internally consistent.
    await new Monitor(f.options, ethers.provider, new Capture()).run();
    const initial = JSON.parse(fs.readFileSync(f.checkpoint));
    const evidenceBlock = initial.nextBlock - 1;
    const originalHash = initial.hashes.find((h) => h.number === evidenceBlock).hash.toLowerCase();
    const forkB = `0x${"b1".repeat(32)}`, forkC = `0x${"c2".repeat(32)}`;

    const first = new Capture();
    await new Monitor(f.options, new ReorgProvider(ethers.provider, evidenceBlock, forkB), first).run();
    const firstReorg = first.records().filter((r) => r.type === "rpc_reorg");
    expect(firstReorg).to.have.length(1);
    expect(firstReorg[0]).to.include({
      evidenceBlock, previousBlockHash: originalHash, replacementBlockHash: forkB,
      previousNextBlock: initial.nextBlock, rewindTo: evidenceBlock
    });

    const sameForkRestart = new Capture();
    await new Monitor(f.options, new ReorgProvider(ethers.provider, evidenceBlock, forkB), sameForkRestart).run();
    expect(sameForkRestart.records().filter((r) => r.type === "rpc_reorg")).to.have.length(0);

    const second = new Capture();
    await new Monitor(f.options, new ReorgProvider(ethers.provider, evidenceBlock, forkC), second).run();
    const secondReorg = second.records().filter((r) => r.type === "rpc_reorg");
    expect(secondReorg).to.have.length(1);
    expect(secondReorg[0]).to.include({
      evidenceBlock, previousBlockHash: forkB, replacementBlockHash: forkC,
      previousNextBlock: initial.nextBlock, rewindTo: evidenceBlock
    });

    const secondRestart = new Capture();
    await new Monitor(f.options, new ReorgProvider(ethers.provider, evidenceBlock, forkC), secondRestart).run();
    expect(secondRestart.records().filter((r) => r.type === "rpc_reorg")).to.have.length(0);
    const journal = fs.readFileSync(`${f.checkpoint}.alerts.jsonl`, "utf8").trim().split("\n").slice(1).map(JSON.parse);
    const durableReorgs = journal.filter((item) => item.record.type === "rpc_reorg");
    expect(durableReorgs).to.have.length(2);
    expect(new Set(durableReorgs.map((item) => item.id)).size).to.equal(2);
    fs.rmSync(f.dir, { recursive: true, force: true });
  });

  it("does not checkpoint an alert when output delivery fails", async function () {
    const f = await fixture(9, 93); const broken = { write(_s, cb) { cb(new Error("sink failed")); return false; } };
    const error = await rejectedRun(f.options, ethers.provider, broken); expect(error.message).to.equal("sink failed");
    expect(JSON.parse(fs.readFileSync(f.checkpoint)).nextBlock).to.equal(f.eventBlock);
    expect(JSON.parse(fs.readFileSync(`${f.checkpoint}.alerts.json`)).pending).to.have.length(1);
    const capture = new Capture(); await new Monitor(f.options, ethers.provider, capture).run();
    expect(capture.records().some((r) => r.event === "WithdrawalScheduled")).to.equal(true);
    expect(JSON.parse(fs.readFileSync(`${f.checkpoint}.alerts.json`)).pending).to.deep.equal([]); fs.rmSync(f.dir, { recursive: true, force: true });
  });

  it("fsyncs an alert before an injected crash and replays it on restart", async function () {
    const f = await fixture(19, 96); let injected = false;
    const crash = { afterSpool() { if (!injected) { injected = true; throw new Error("injected crash"); } } };
    const error = await rejectedRunWithFaults(f.options, ethers.provider, new Capture(), crash);
    expect(error.message).to.equal("injected crash");
    expect(JSON.parse(fs.readFileSync(f.checkpoint)).nextBlock).to.equal(f.eventBlock);
    const stored = JSON.parse(fs.readFileSync(`${f.checkpoint}.alerts.json`)); expect(stored.pending).to.have.length(1);
    expect(stored.pending[0].record.event).to.equal("WithdrawalScheduled");
    const replay = new Capture(); await new Monitor(f.options, ethers.provider, replay).run();
    expect(replay.records()[0].event).to.equal("WithdrawalScheduled"); fs.rmSync(f.dir, { recursive: true, force: true });
  });

  it("does not checkpoint or discard the spool when journaling fails after stdout accepts", async function () {
    const f = await fixture(23, 101); const accepted = new Capture(); let injected = false;
    const failure = { journalBeforeFsync() { if (!injected) { injected = true; throw new Error("injected journal fsync failure"); } } };
    const error = await rejectedRunWithFaults(f.options, ethers.provider, accepted, failure);
    expect(error.message).to.equal("injected journal fsync failure");
    expect(accepted.records().some((r) => r.event === "WithdrawalScheduled")).to.equal(true);
    expect(JSON.parse(fs.readFileSync(f.checkpoint)).nextBlock).to.equal(f.eventBlock);
    const pending = JSON.parse(fs.readFileSync(`${f.checkpoint}.alerts.json`)).pending;
    expect(pending).to.have.length(1); expect(pending[0].record.event).to.equal("WithdrawalScheduled");

    const restarted = new Capture(); await new Monitor(f.options, ethers.provider, restarted).run();
    expect(restarted.records().some((r) => r.event === "WithdrawalScheduled")).to.equal(true);
    expect(JSON.parse(fs.readFileSync(`${f.checkpoint}.alerts.json`)).pending).to.deep.equal([]);
    const journal = fs.readFileSync(`${f.checkpoint}.alerts.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
    expect(journal.slice(1).filter((x) => x.record.event === "WithdrawalScheduled")).to.have.length(1);
    expect(JSON.parse(fs.readFileSync(f.checkpoint)).nextBlock).to.be.greaterThan(f.eventBlock);
    fs.rmSync(f.dir, { recursive: true, force: true });
  });

  it("does not re-emit a journaled alert after checkpoint failure and rejects its conflicting journal ID", async function () {
    const f = await fixture(27, 104); const accepted = new Capture();
    const renameSync = fs.renameSync; let checkpointRenames = 0;
    fs.renameSync = function (from, to) {
      if (to === f.checkpoint && ++checkpointRenames === 2) throw new Error("injected checkpoint rename failure");
      return renameSync.call(this, from, to);
    };
    let error;
    try { error = await rejectedRun(f.options, ethers.provider, accepted); }
    finally { fs.renameSync = renameSync; }

    expect(error.message).to.equal("injected checkpoint rename failure");
    expect(accepted.records().filter((r) => r.event === "WithdrawalScheduled")).to.have.length(1);
    expect(JSON.parse(fs.readFileSync(f.checkpoint)).nextBlock).to.equal(f.eventBlock);
    expect(JSON.parse(fs.readFileSync(`${f.checkpoint}.alerts.json`)).pending).to.deep.equal([]);
    const journalFile = `${f.checkpoint}.alerts.jsonl`;
    const journal = fs.readFileSync(journalFile, "utf8").trim().split("\n").map(JSON.parse);
    const delivered = journal.find((item) => item.record && item.record.event === "WithdrawalScheduled");
    expect(delivered).to.exist;

    const restarted = new Capture(); await new Monitor(f.options, ethers.provider, restarted).run();
    expect(restarted.records().filter((r) => r.event === "WithdrawalScheduled")).to.have.length(0);
    expect(JSON.parse(fs.readFileSync(f.checkpoint)).nextBlock).to.be.greaterThan(f.eventBlock);

    fs.appendFileSync(journalFile, JSON.stringify({ id: delivered.id, record: { ...delivered.record, severity: "warning" } }) + "\n");
    error = await rejectedRun(f.options, ethers.provider);
    expect(error.message).to.match(/journal contains a conflicting duplicate ID/);
    fs.rmSync(f.dir, { recursive: true, force: true });
  });

  it("retains a replay record when restarted output fails", async function () {
    const f = await fixture(20, 97); const fail = { write(_s, cb) { cb(new Error("first output down")); return false; } };
    await rejectedRun(f.options, ethers.provider, fail);
    const failAgain = { write(_s, cb) { cb(new Error("replay output down")); return false; } };
    const error = await rejectedRun(f.options, ethers.provider, failAgain); expect(error.message).to.equal("replay output down");
    expect(JSON.parse(fs.readFileSync(`${f.checkpoint}.alerts.json`)).pending).to.have.length(1);
    const recovered = new Capture(); await new Monitor(f.options, ethers.provider, recovered).run();
    expect(recovered.records()[0].event).to.equal("WithdrawalScheduled"); fs.rmSync(f.dir, { recursive: true, force: true });
  });

  it("repairs a torn journal tail and replays the durable spool record", async function () {
    const f = await fixture(25, 103);
    const unavailable = { write(_s, cb) { cb(new Error("output unavailable")); return false; } };
    await rejectedRun(f.options, ethers.provider, unavailable);
    const journalFile = `${f.checkpoint}.alerts.jsonl`;
    const committed = fs.readFileSync(journalFile, "utf8");
    fs.appendFileSync(journalFile, '{"id":"torn","record":');

    const recovered = new Capture(); await new Monitor(f.options, ethers.provider, recovered).run();
    expect(recovered.records().filter((r) => r.event === "WithdrawalScheduled")).to.have.length(1);
    expect(JSON.parse(fs.readFileSync(`${f.checkpoint}.alerts.json`)).pending).to.deep.equal([]);
    const repaired = fs.readFileSync(journalFile, "utf8");
    expect(repaired.startsWith(committed)).to.equal(true);
    expect(repaired).not.to.include('"id":"torn"');
    expect(repaired.endsWith("\n")).to.equal(true);
    expect(repaired.trim().split("\n").map(JSON.parse)).to.have.length(2);
    fs.rmSync(f.dir, { recursive: true, force: true });
  });

  it("binds and bounds the spool and refuses symlinks", async function () {
    const f = await fixture(21, 98); await new Monitor(f.options, ethers.provider, new Capture()).run();
    const spoolFile = `${f.checkpoint}.alerts.json`, spool = JSON.parse(fs.readFileSync(spoolFile));
    fs.writeFileSync(spoolFile, JSON.stringify({ ...spool, identity: { ...spool.identity, chainId: "56" } }));
    let error = await rejectedRun(f.options, ethers.provider); expect(error.message).to.match(/identity mismatch/);
    fs.writeFileSync(spoolFile, JSON.stringify(spool));
    const linked = path.join(f.dir, "linked-spool.json"); fs.symlinkSync(spoolFile, linked);
    error = await rejectedRun({ ...f.options, spool: linked }, ethers.provider); expect(error.message).to.match(/not a symlink/);
    fs.writeFileSync(spoolFile, "x".repeat(2048));
    error = await rejectedRun({ ...f.options, spoolMaxBytes: 1024 }, ethers.provider); expect(error.message).to.match(/size limit/);
    fs.rmSync(f.dir, { recursive: true, force: true });
  });

  it("rejects duplicate pending spool IDs", async function () {
    const f = await fixture(24, 102); await new Monitor(f.options, ethers.provider, new Capture()).run();
    const spoolFile = `${f.checkpoint}.alerts.json`, spool = JSON.parse(fs.readFileSync(spoolFile));
    const record = { safumode: 1, type: "vault_event" };
    spool.pending = [{ id: "duplicate", record }, { id: "duplicate", record }];
    fs.writeFileSync(spoolFile, JSON.stringify(spool));
    const error = await rejectedRun(f.options, ethers.provider); expect(error.message).to.match(/duplicate pending records/);
    fs.rmSync(f.dir, { recursive: true, force: true });
  });

  it("rejects future starts and future checkpoints", async function () {
    const f = await fixture(10, 94); const head = await ethers.provider.getBlockNumber();
    let error = await rejectedRun({ ...f.options, startBlock: head + 2 }, ethers.provider); expect(error.message).to.match(/start-block is ahead/);
    fs.writeFileSync(f.checkpoint, JSON.stringify({ version: 1, chainId: "31337", address: f.address, codeHash: f.options.codeHash, nextBlock: head + 2, hashes: [] }));
    error = await rejectedRun(f.options, ethers.provider); expect(error.message).to.match(/checkpoint is (ahead|missing)/); fs.rmSync(f.dir, { recursive: true, force: true });
  });
});
