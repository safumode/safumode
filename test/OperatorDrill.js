const { expect } = require("chai");
const { ethers } = require("hardhat");
const { runOperatorDrill } = require("../scripts/operator-drill");

describe("SAFUMODE local operator drill", function () {
  it("completes the offline-sign/local-relay lifecycle", async function () {
    const summary = await runOperatorDrill({ quiet: true, delay: 2 });
    expect(summary.chainId).to.equal("31337");
    expect(summary.authorityEpoch).to.equal("1");
    expect(summary.vetoedRotationNonce).to.equal("1");
    expect(summary.activatedRotationNonce).to.equal("2");
    expect(summary.vetoingAuthority).to.match(/^0x[0-9A-Fa-f]{40}$/);
    expect(summary.vetoUsedIndependentSignature).to.equal(true);
    expect(summary.vetoUsedGuardedLocalRelay).to.equal(true);
    expect(summary.finalBalance).to.equal(ethers.parseEther("8").toString());
    expect(summary.assertions).to.equal("passed");
    expect(summary.requestId).to.match(/^0x[0-9a-f]{64}$/);
  });
});
