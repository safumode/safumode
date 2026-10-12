const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { acknowledge, inspect, parseArgs } = require("../scripts/safumode-alerts");

const address = "0x000000000000000000000000000000000000dEaD";
const identity = { chainId: "56", address, codeHash: `0x${"ab".repeat(32)}` };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safumode-alerts-"));
  const journal = path.join(dir, "alerts.jsonl"), acks = path.join(dir, "acks.json");
  const record = { safumode: 1, type: "vault_event", severity: "critical" };
  fs.writeFileSync(journal, [
    JSON.stringify({ safumodeJournal: 1, identity }),
    JSON.stringify({ id: "alert-1", record }),
    JSON.stringify({ id: "alert-2", record: { ...record, type: "rpc_reorg" } }),
    ""
  ].join("\n"), { mode: 0o600 });
  return { dir, journal, acks, base: { journal, acks, chainId: "56", address } };
}

describe("SAFUMODE offline alert journal CLI", function () {
  it("inspects bounded records and verifies exact chain/address identity", function () {
    const f = fixture();
    try {
      expect(inspect({ ...f.base, limit: 1 })).to.deep.equal([{
        id: "alert-2", record: { safumode: 1, type: "rpc_reorg", severity: "critical" }, acknowledged: false
      }]);
      expect(() => inspect({ ...f.base, chainId: "1", limit: 1 })).to.throw(/identity mismatch/);
      expect(() => inspect({ ...f.base, address: address.toLowerCase(), limit: 1 })).to.throw(/exact checksum form/);
      expect(() => parseArgs(["inspect", "--journal", f.journal, "--chain-id", "56", "--address", address, "--limit", "1001"])).to.throw(/between 1 and 1000/);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("acknowledges without altering evidence and is idempotent across restart", function () {
    const f = fixture();
    try {
      const evidence = fs.readFileSync(f.journal);
      const first = acknowledge({ ...f.base, id: "alert-1" }, () => "2026-01-01T00:00:00.000Z");
      expect(first).to.deep.equal({ id: "alert-1", acknowledgedAt: "2026-01-01T00:00:00.000Z", alreadyAcknowledged: false });
      expect(fs.readFileSync(f.journal).equals(evidence)).to.equal(true);
      expect(inspect({ ...f.base, limit: 2 }).map((x) => x.acknowledged)).to.deep.equal([true, false]);

      // A fresh module-level operation models process restart. A duplicate does
      // not rewrite state or change the original audit timestamp.
      const before = fs.readFileSync(f.acks);
      const duplicate = acknowledge({ ...f.base, id: "alert-1" }, () => "2099-01-01T00:00:00.000Z");
      expect(duplicate).to.deep.equal({ id: "alert-1", acknowledgedAt: "2026-01-01T00:00:00.000Z", alreadyAcknowledged: true });
      expect(fs.readFileSync(f.acks).equals(before)).to.equal(true);
      expect(JSON.parse(before).identity).to.deep.equal(identity);
      expect(fs.statSync(f.acks).mode & 0o777).to.equal(0o600);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("fails closed on journal and acknowledgement corruption", function () {
    const f = fixture();
    try {
      const validJournal = fs.readFileSync(f.journal);
      fs.appendFileSync(f.journal, '{"id":"torn"');
      expect(() => inspect({ ...f.base, limit: 2 })).to.throw(/torn or unterminated/);
      fs.writeFileSync(f.journal, validJournal);
      acknowledge({ ...f.base, id: "alert-1" }, () => "2026-01-01T00:00:00.000Z");
      fs.writeFileSync(f.acks, "not json\n");
      expect(() => inspect({ ...f.base, limit: 2 })).to.throw(/acknowledgement file is unreadable/);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("leaves the prior durable acknowledgement intact when atomic replacement fails", function () {
    const f = fixture();
    try {
      acknowledge({ ...f.base, id: "alert-1" }, () => "2026-01-01T00:00:00.000Z");
      const before = fs.readFileSync(f.acks);
      const originalRename = fs.renameSync;
      fs.renameSync = () => { throw new Error("injected rename failure"); };
      try { expect(() => acknowledge({ ...f.base, id: "alert-2" })).to.throw("injected rename failure"); }
      finally { fs.renameSync = originalRename; }
      expect(fs.readFileSync(f.acks).equals(before)).to.equal(true);
      expect(fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp"))).to.deep.equal([]);
      expect(fs.existsSync(`${f.acks}.lock`)).to.equal(false);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("fails closed on lock contention and preserves distinct acknowledgements", function () {
    const f = fixture();
    try {
      fs.writeFileSync(`${f.acks}.lock`, "other owner\n", { flag: "wx", mode: 0o600 });
      expect(() => acknowledge({ ...f.base, id: "alert-1" })).to.throw(/busy/);
      expect(fs.readFileSync(`${f.acks}.lock`, "utf8")).to.equal("other owner\n");
      fs.unlinkSync(`${f.acks}.lock`);

      acknowledge({ ...f.base, id: "alert-1" }, () => "2026-01-01T00:00:00.000Z");
      acknowledge({ ...f.base, id: "alert-2" }, () => "2026-01-01T00:00:01.000Z");
      expect(JSON.parse(fs.readFileSync(f.acks, "utf8")).acknowledged.map((x) => x.id)).to.deep.equal(["alert-1", "alert-2"]);
      expect(fs.existsSync(`${f.acks}.lock`)).to.equal(false);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("does not remove a replacement lock during inode-checked cleanup", function () {
    const f = fixture();
    try {
      const replacement = "replacement owner\n";
      acknowledge({ ...f.base, id: "alert-1" }, () => {
        fs.unlinkSync(`${f.acks}.lock`);
        fs.writeFileSync(`${f.acks}.lock`, replacement, { flag: "wx", mode: 0o600 });
        return "2026-01-01T00:00:00.000Z";
      });
      expect(fs.readFileSync(`${f.acks}.lock`, "utf8")).to.equal(replacement);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("rejects journal/acknowledgement hardlink aliases", function () {
    const f = fixture();
    try {
      fs.linkSync(f.journal, f.acks);
      expect(() => inspect({ ...f.base, limit: 2 })).to.throw(/hardlinks/);
      expect(() => acknowledge({ ...f.base, id: "alert-1" })).to.throw(/hardlinks/);
      expect(fs.existsSync(`${f.acks}.lock`)).to.equal(false);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });
});
