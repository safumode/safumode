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

  it("retains a replay record when restarted output fails", async function () {
    const f = await fixture(20, 97); const fail = { write(_s, cb) { cb(new Error("first output down")); return false; } };
    await rejectedRun(f.options, ethers.provider, fail);
    const failAgain = { write(_s, cb) { cb(new Error("replay output down")); return false; } };
    const error = await rejectedRun(f.options, ethers.provider, failAgain); expect(error.message).to.equal("replay output down");
    expect(JSON.parse(fs.readFileSync(`${f.checkpoint}.alerts.json`)).pending).to.have.length(1);
    const recovered = new Capture(); await new Monitor(f.options, ethers.provider, recovered).run();
    expect(recovered.records()[0].event).to.equal("WithdrawalScheduled"); fs.rmSync(f.dir, { recursive: true, force: true });
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

  it("rejects future starts and future checkpoints", async function () {
    const f = await fixture(10, 94); const head = await ethers.provider.getBlockNumber();
    let error = await rejectedRun({ ...f.options, startBlock: head + 2 }, ethers.provider); expect(error.message).to.match(/start-block is ahead/);
    fs.writeFileSync(f.checkpoint, JSON.stringify({ version: 1, chainId: "31337", address: f.address, codeHash: f.options.codeHash, nextBlock: head + 2, hashes: [] }));
    error = await rejectedRun(f.options, ethers.provider); expect(error.message).to.match(/checkpoint is (ahead|missing)/); fs.rmSync(f.dir, { recursive: true, force: true });
  });
});
