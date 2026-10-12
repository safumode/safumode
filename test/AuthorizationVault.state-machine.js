const { expect } = require("chai");
const { ethers } = require("hardhat");

const TYPES = {
  Withdraw: [
    { name: "asset", type: "address" }, { name: "to", type: "address" },
    { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }, { name: "immediate", type: "bool" },
  ],
  SetTrusted: [
    { name: "account", type: "address" }, { name: "trusted", type: "bool" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
  Cancel: [
    { name: "requestId", type: "bytes32" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Recover: [
    { name: "asset", type: "address" }, { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
  SetPaused: [
    { name: "paused", type: "bool" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  RotateAuthorities: [
    { name: "authorizer", type: "address" }, { name: "recoveryAuthorizer", type: "address" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
  CancelRotation: [
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
};

// xorshift32 is deliberately tiny and stable across Node versions.  Failures include
// the seed and transition number, so a single walk can be replayed with SM_SEEDS.
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return x >>> 0;
  };
}

const DEFAULT_SEEDS = [0x5afe0001, 0xc0ffee42, 0xdeadbeef];
const SEEDS = process.env.SM_SEEDS
  ? process.env.SM_SEEDS.split(",").map((x) => Number(BigInt(x.trim())))
  : DEFAULT_SEEDS;
const STEPS = Number(process.env.SM_STEPS || 125);

describe("AuthorizationVault deterministic state machine", function () {
  this.timeout(180000);

  for (const seed of SEEDS) {
    it(`preserves security invariants (seed=0x${seed.toString(16)}, steps=${STEPS})`, async function () {
      const signers = await ethers.getSigners();
      const [funder, a0, r0, recoveryRecipient, alice, bob, carol, relayer] = signers;
      const authorityPairs = [[a0, r0], [signers[8], signers[9]], [signers[10], signers[11]], [signers[12], signers[13]]];
      const users = [alice, bob, carol];
      const delay = 37;
      const vault = await ethers.deployContract("AuthorizationVault", [a0, r0, recoveryRecipient, delay]);
      const token = await ethers.deployContract("MockToken");
      const vaultAddress = await vault.getAddress();
      const tokenAddress = await token.getAddress();
      await funder.sendTransaction({ to: vault, value: 1000n });
      await token.mint(funder, 1000n);
      await token.approve(vault, 1000n);
      await vault.depositToken(token, 1000n);

      const random = rng(seed);
      const pick = (xs) => xs[random() % xs.length];
      const model = {
        epoch: 0n, paused: false, controlNonce: 0n, rotationNonce: 0n,
        pair: 0, pendingRotation: null, native: 1000n, tokens: 1000n,
        trustNonce: new Map(users.map((u) => [u.address, 0n])),
        trustedEpoch: new Map(), pendingTrust: new Map(), requests: [], staleRequests: [], staleTrusts: [],
        authorizerNonces: new Set(), recoveryNonces: new Set(), nextAuthNonce: 1000n, nextRecoveryNonce: 5000n,
      };
      const initialRecoveryRecipient = await vault.recoveryRecipient();
      const domain = async () => ({
        name: "Authorization Vault Prototype", version: await vault.VERSION(), chainId: 31337,
        verifyingContract: vaultAddress,
      });
      const sign = async (signer, type, value) => signer.signTypedData(await domain(), { [type]: TYPES[type] }, value);
      const now = async () => BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const deadline = async () => (await now()) + 100000n;
      const advance = async (seconds) => {
        await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
        await ethers.provider.send("evm_mine");
      };
      const currentA = () => authorityPairs[model.pair][0];
      const currentR = () => authorityPairs[model.pair][1];
      const expectedFailure = async (call, nonceKind, nonce, error) => {
        const nativeBefore = await ethers.provider.getBalance(vaultAddress);
        const tokenBefore = await token.balanceOf(vaultAddress);
        await expect(call()).to.be.revertedWithCustomError(vault, error);
        expect(await ethers.provider.getBalance(vaultAddress)).to.equal(nativeBefore);
        expect(await token.balanceOf(vaultAddress)).to.equal(tokenBefore);
        if (nonceKind === "a") expect(await vault.authorizerNonceUsed(nonce)).to.equal(false);
        if (nonceKind === "r") expect(await vault.recoveryNonceUsed(nonce)).to.equal(false);
      };

      async function invariant(step, action) {
        const tag = `seed=0x${seed.toString(16)} step=${step} action=${action}`;
        try {
          expect(await vault.authorityEpoch()).to.equal(model.epoch);
          expect(await vault.VERSION()).to.equal(`1:${model.epoch}`);
          expect(await vault.authorizer()).to.equal(currentA().address);
          expect(await vault.recoveryAuthorizer()).to.equal(currentR().address);
          expect(await vault.recoveryRecipient()).to.equal(initialRecoveryRecipient);
          expect(await vault.paused()).to.equal(model.paused);
          expect(await vault.controlNonce()).to.equal(model.controlNonce);
          expect(await vault.rotationNonce()).to.equal(model.rotationNonce);
          expect(await ethers.provider.getBalance(vaultAddress)).to.equal(model.native);
          expect(await token.balanceOf(vaultAddress)).to.equal(model.tokens);
          for (const u of users) {
            const expected = model.trustedEpoch.get(u.address) === model.epoch;
            expect(await vault.trusted(u)).to.equal(expected);
            expect(await vault.trustNonce(u)).to.equal(model.trustNonce.get(u.address));
          }
          // Rotation must make every older queued capability non-executable.
          if (model.staleRequests.length) {
            const q = pick(model.staleRequests);
            await expect(vault.connect(relayer).executeWithdrawal(q.id)).to.be.revertedWithCustomError(vault, model.paused ? "Paused" : "RequestMissing");
          }
          if (model.staleTrusts.length) {
            const t = pick(model.staleTrusts);
            await expect(vault.connect(relayer).activateTrust(t.account, t.nonce)).to.be.revertedWithCustomError(vault, model.paused ? "Paused" : "TrustChangeMissing");
          }
        } catch (e) {
          e.message = `${tag}: ${e.message}`;
          throw e;
        }
      }

      const actions = ["pause", "rotation", "trust", "withdrawal", "recovery", "advance", "failed-outflow"];
      for (let step = 0; step < STEPS; step++) {
        const action = pick(actions);
        try {
          if (action === "pause") {
            const d = await deadline();
            if (!model.paused) {
              const nonce = model.controlNonce + 1n;
              const value = { paused: true, nonce, deadline: d };
              const byRecovery = (random() & 1) === 1;
              await vault.setPaused(true, byRecovery, nonce, d, await sign(byRecovery ? currentR() : currentA(), "SetPaused", value), "0x");
              model.paused = true; model.controlNonce = nonce;
            } else if ((random() % 3) !== 0) {
              const nonce = model.controlNonce + 1n;
              const value = { paused: false, nonce, deadline: d };
              await vault.setPaused(false, false, nonce, d, await sign(currentA(), "SetPaused", value), await sign(currentR(), "SetPaused", value));
              model.paused = false; model.controlNonce = nonce;
            } else {
              const nonce = model.controlNonce + 1n;
              const value = { paused: false, nonce, deadline: d };
              await expect(vault.setPaused(false, false, nonce, d, await sign(currentA(), "SetPaused", value), await sign(currentA(), "SetPaused", value)))
                .to.be.revertedWithCustomError(vault, "InvalidSignature");
              expect(await vault.controlNonce()).to.equal(model.controlNonce);
            }
          } else if (action === "rotation") {
            if (model.pendingRotation && (random() % 2)) {
              const p = model.pendingRotation;
              if ((random() % 2) === 0) {
                const d = await deadline();
                const byRecovery = (random() & 1) === 1;
                const value = { nonce: p.nonce, deadline: d };
                await vault.cancelRotation(byRecovery, p.nonce, d, await sign(byRecovery ? currentR() : currentA(), "CancelRotation", value));
                model.pendingRotation = null;
              } else {
                const onchain = await vault.pendingRotation();
                if ((await now()) < onchain.executableAt) await advance(onchain.executableAt - (await now()));
                if (model.paused) {
                  await expect(vault.activateRotation(p.nonce)).to.be.revertedWithCustomError(vault, "Paused");
                  expect((await vault.pendingRotation()).nonce).to.equal(p.nonce);
                } else {
                  await vault.activateRotation(p.nonce);
                  model.staleRequests.push(...model.requests.filter((q) => !q.done && q.epoch === model.epoch));
                  model.staleTrusts.push(...[...model.pendingTrust.values()].filter((t) => t.epoch === model.epoch));
                  model.pair = p.pair; model.epoch++; model.pendingRotation = null;
                  model.pendingTrust.clear();
                }
              }
            } else if (!model.pendingRotation && model.pair + 1 < authorityPairs.length) {
              const pair = model.pair + 1, nonce = model.rotationNonce + 1n, d = await deadline();
              const value = { authorizer: authorityPairs[pair][0].address, recoveryAuthorizer: authorityPairs[pair][1].address, nonce, deadline: d };
              if (model.paused) {
                await expect(vault.scheduleRotation(value.authorizer, value.recoveryAuthorizer, nonce, d,
                  await sign(currentA(), "RotateAuthorities", value), await sign(currentR(), "RotateAuthorities", value)))
                  .to.be.revertedWithCustomError(vault, "Paused");
                expect(await vault.rotationNonce()).to.equal(model.rotationNonce);
              } else {
                await vault.scheduleRotation(value.authorizer, value.recoveryAuthorizer, nonce, d,
                  await sign(currentA(), "RotateAuthorities", value), await sign(currentR(), "RotateAuthorities", value));
                model.rotationNonce = nonce; model.pendingRotation = { pair, nonce };
              }
            }
          } else if (action === "trust") {
            const account = pick(users), old = model.trustNonce.get(account.address), nonce = old + 1n, d = await deadline();
            if ((random() % 3) === 0) {
              const value = { account: account.address, trusted: false, nonce, deadline: d };
              await vault.revokeTrust(account, nonce, d, await sign(currentA(), "SetTrusted", value));
              model.trustNonce.set(account.address, nonce); model.trustedEpoch.delete(account.address); model.pendingTrust.delete(account.address);
            } else if (model.pendingTrust.has(account.address) && !model.paused) {
              const p = model.pendingTrust.get(account.address);
              const chain = await vault.pendingTrust(account);
              if ((await now()) < chain.executableAt) await advance(chain.executableAt - (await now()));
              await vault.activateTrust(account, p.nonce);
              model.trustedEpoch.set(account.address, model.epoch); model.pendingTrust.delete(account.address);
            } else {
              const value = { account: account.address, trusted: true, nonce, deadline: d };
              if (model.paused) {
                await expect(vault.scheduleTrust(account, nonce, d, await sign(currentA(), "SetTrusted", value), await sign(currentR(), "SetTrusted", value)))
                  .to.be.revertedWithCustomError(vault, "Paused");
                expect(await vault.trustNonce(account)).to.equal(old);
              } else {
                await vault.scheduleTrust(account, nonce, d, await sign(currentA(), "SetTrusted", value), await sign(currentR(), "SetTrusted", value));
                model.trustNonce.set(account.address, nonce);
                model.pendingTrust.set(account.address, { account, nonce, epoch: model.epoch });
              }
            }
          } else if (action === "withdrawal") {
            const live = model.requests.filter((q) => !q.done && q.epoch === model.epoch);
            if (live.length && (random() % 2)) {
              const q = pick(live);
              if ((random() % 3) === 0) {
                const byRecovery = (random() & 1) === 1;
                const nonce = byRecovery ? model.nextRecoveryNonce++ : model.nextAuthNonce++;
                const d = await deadline(), value = { requestId: q.id, nonce, deadline: d };
                await vault.cancelWithdrawal(q.id, byRecovery, nonce, d, await sign(byRecovery ? currentR() : currentA(), "Cancel", value));
                q.done = true; (byRecovery ? model.recoveryNonces : model.authorizerNonces).add(nonce.toString());
              } else if (!model.paused) {
                const chain = await vault.requests(q.id);
                if ((await now()) < chain.executableAt) await advance(chain.executableAt - (await now()));
                await vault.executeWithdrawal(q.id);
                q.done = true; model[q.asset === ethers.ZeroAddress ? "native" : "tokens"] -= q.amount;
              } else {
                await expectedFailure(() => vault.executeWithdrawal(q.id), null, 0n, "Paused");
              }
            } else {
              const to = pick(users), asset = (random() & 1) ? ethers.ZeroAddress : tokenAddress;
              const available = asset === ethers.ZeroAddress ? model.native : model.tokens;
              const amount = available ? BigInt((random() % Number(available > 20n ? 20n : available)) + 1) : 0n;
              const nonce = model.nextAuthNonce++, d = await deadline();
              const value = { asset, to: to.address, amount, nonce, deadline: d, immediate: false };
              const sig = await sign(currentA(), "Withdraw", value);
              if (model.paused) {
                await expectedFailure(() => vault.scheduleWithdrawal(asset, to, amount, nonce, d, sig), "a", nonce, "Paused");
              } else if (model.trustedEpoch.get(to.address) === model.epoch) {
                await expectedFailure(() => vault.scheduleWithdrawal(asset, to, amount, nonce, d, sig), "a", nonce, "RecipientTrustMismatch");
              } else {
                const id = await vault.scheduleWithdrawal.staticCall(asset, to, amount, nonce, d, sig);
                await vault.scheduleWithdrawal(asset, to, amount, nonce, d, sig);
                model.authorizerNonces.add(nonce.toString()); model.requests.push({ id, asset, amount, epoch: model.epoch, done: false });
              }
            }
          } else if (action === "recovery") {
            const asset = (random() & 1) ? ethers.ZeroAddress : tokenAddress;
            const available = asset === ethers.ZeroAddress ? model.native : model.tokens;
            const amount = available ? BigInt((random() % Number(available > 15n ? 15n : available)) + 1) : 0n;
            const nonce = model.nextRecoveryNonce++, d = await deadline();
            const value = { asset, amount, nonce, deadline: d }, sig = await sign(currentR(), "Recover", value);
            if (model.paused) await expectedFailure(() => vault.recover(asset, amount, nonce, d, sig), "r", nonce, "Paused");
            else {
              await vault.recover(asset, amount, nonce, d, sig);
              model.recoveryNonces.add(nonce.toString()); model[asset === ethers.ZeroAddress ? "native" : "tokens"] -= amount;
            }
          } else if (action === "failed-outflow") {
            // A valid signature with an impossible amount reaches _transfer; the revert
            // must roll back nonce consumption and every balance mutation.
            const nonce = model.nextRecoveryNonce++, d = await deadline(), amount = model.native + 1n;
            const value = { asset: ethers.ZeroAddress, amount, nonce, deadline: d };
            const sig = await sign(currentR(), "Recover", value);
            await expectedFailure(() => vault.recover(ethers.ZeroAddress, amount, nonce, d, sig), "r", nonce, model.paused ? "Paused" : "TransferFailed");
          } else {
            await advance(BigInt(random() % (delay * 2 + 1)));
          }
          await invariant(step, action);
        } catch (e) {
          e.message = `STATE MACHINE FAILURE seed=0x${seed.toString(16)} step=${step} action=${action}; replay: SM_SEEDS=0x${seed.toString(16)} SM_STEPS=${STEPS} npx hardhat test test/AuthorizationVault.state-machine.js\n${e.message}`;
          throw e;
        }
      }
    });
  }
});
