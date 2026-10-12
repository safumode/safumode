# Testing

All automated tests deploy only to Hardhat chain ID `31337`. They use development accounts or generated throwaway wallets. They do not contact a public chain, validate real custody devices, or establish production readiness.

## Reproduce the CI checks

GitHub Actions uses Node 22 on `ubuntu-latest` with a 15 minute job timeout. The workflow in `.github/workflows/verify.yml` runs these commands in this order:

```sh
npm ci
npm test
npm run test:e2e:lifecycle
npm run operator:drill
npm run test:e2e:ui
npm run build
git diff --exit-code -- package-lock.json
```

The browser step installs Chrome in CI. For a local run, install Chrome or Chromium and set `CHROME_PATH` if automatic detection does not find it:

```sh
CHROME_PATH=/path/to/chrome npm run test:e2e:ui
```

`npm ci` is important because build identity includes the SHA-256 hash of `package-lock.json`. `npm run build` replaces `dist/` with the six static files selected by `web/build.js`. The final CI command checks only that installation and the preceding commands did not modify `package-lock.json`; it is not a general clean-tree check.

## What `npm test` covers

`npm test` runs `hardhat test`, which currently discovers every JavaScript file under `test/`. On the verified working tree it completed with 112 passing tests.

| Area | Test files | Exercised behavior |
| :--- | :--- | :--- |
| Core contract | `test/AuthorizationVault.js`, `test/AuthorizationVault.adversarial.js`, `test/AuthorizationVault.edge-regressions.js`, `test/AuthorizationVault.hardening.js`, `test/AuthorizationVault.delay-overflow.js` | Deposits, trust policy, delayed and immediate withdrawals, fixed-recipient recovery, pause and resume, authority rotation and veto, EIP-712 field and domain binding, signature malleability rejection, replay, exact timing boundaries, nonce ordering, callback reentrancy, and rotation invalidation. |
| Asset accounting | `test/AuthorizationVault.exact-outbound.js`, relevant adversarial tests | Native transfers, conventional ERC20 behavior, net-received deposits, false-returning tokens, recipient-fee and sender-fee failures, and rollback of nonce or request state after failed outbound transfers. |
| Key loss and model sequences | `test/AuthorizationVault.key-loss.js`, `test/AuthorizationVault.state-machine.js` | Deterministic one-key-loss outcomes and three fixed-seed state-machine runs of 125 steps each. |
| Deployment identity | `test/DeploymentManifest.js` | Local manifest generation, chain and address binding, runtime code, constructor state and calldata, deployment transaction, compiler and source identity, lockfile identity, changed build rejection, and legitimate post-deployment authority rotation. |
| Transaction tooling | `test/SafumodeTx.js`, `test/SafumodeTx.dry-run.js`, `test/SafumodeTx.cancel-rotation.js`, `test/SafumodeTx.unpause-ordering.js`, `test/SafumodeRelayerProvider.js` | Offline bundle preparation, every signed action family, simulation without mutation, local relay guards, malformed or stale metadata rejection, rotation veto, unpause signature ordering, and same-address signer rejection across distinct provider objects. |
| Unsigned lifecycle library | `test/SafumodeLifecycle.e2e.js` | Simulation and broadcast for trust activation, withdrawal execution, and rotation activation, plus early, stale, manifest, loopback, and relayer mismatch failures. |
| Monitor | `test/SafumodeMonitor.e2e.js` | Event scanning, restart, chain mismatch, exclusive locking, omitted or inconsistent RPC data, reorg handling, output and journal failures, durable spool replay, torn journal recovery, bounds, symlink refusal, and future checkpoint rejection. |
| Alert journal tool | `test/SafumodeAlerts.js` | Identity-bound inspection, idempotent acknowledgement, corrupt input, atomic replacement failure, lock contention, inode-safe lock cleanup, and hardlink alias refusal. |
| Operator drill | `test/OperatorDrill.js` | The programmatic version of the generated-key, offline-signing, local-relay rehearsal. |

The state-machine tests are bounded deterministic sequences, not an unbounded invariant campaign. The fee-token and sender-fee fixtures demonstrate specific rejection and rollback behavior; they do not characterize arbitrary deployed tokens.

## Standalone end-to-end programs

`npm run test:e2e:lifecycle` compiles, finds a free loopback port, starts a temporary Hardhat node, deploys a one-second-delay vault, and invokes the real `scripts/safumode-cli.js` process. It proves that a lifecycle dry run leaves trust unchanged, then broadcasts through an explicitly selected unlocked local signer and verifies the receipt and final trusted state. The broader lifecycle library cases still live in `test/SafumodeLifecycle.e2e.js` and run under `npm test`.

`npm run operator:drill` executes `scripts/operator-drill.js` through Hardhat's in-process network. It generates authority wallets in memory and verifies the receipt and state of the complete rehearsal described in [OPERATOR.md](OPERATOR.md).

`npm run test:e2e:ui` compiles, starts an ephemeral Hardhat JSON-RPC process and local web server on free loopback ports, creates a temporary browser allowlist, then drives the actual UI with headless Chrome. It checks pinned identity, visible state and events, recipient status, refresh after rotation, stale pending trust display, missing or malformed allowlist failure, bytecode and state mismatch failure, corrupt local storage recovery, unknown-address handling, RPC warning text, and disabled signing. The test deletes its temporary allowlist and stops both child processes. It does not modify the checked-in empty `web/deployment-allowlist.json`.

`npm run build` is a packaging check, not a browser behavior test. It copies `index.html`, `styles.css`, `app.js`, `deployment-allowlist.json`, `safumode-mark.svg`, and `ethers.min.js` from `web/` to `dist/`.

## Focused commands

Use the full suite before relying on a focused result. The package scripts expose these shorter runs:

| Command | Exact scope |
| :--- | :--- |
| `npm run compile` | Hardhat compilation with Solidity 0.8.24, optimizer enabled, 200 runs. |
| `npm run test:safumode` | `test/SafumodeMonitor.e2e.js` and `test/SafumodeAlerts.js` only. |
| `npm run test:manifest` | `test/DeploymentManifest.js` only. |
| `npm run test:tx` | `test/SafumodeTx.js` only. It does not include the separate dry-run, veto, provider-binding, unpause-ordering, or lifecycle files. |
| `npm run test:drill` | `test/OperatorDrill.js` only. |
| `npm run test:e2e:lifecycle` | Standalone lifecycle CLI subprocess test after compilation. |
| `npm run test:e2e:ui` | Standalone browser integration test after compilation. |
| `npm run operator:drill` | Standalone operator rehearsal, also exercised by `test/OperatorDrill.js`. |

An individual Hardhat file can be run directly:

```sh
npx hardhat test test/AuthorizationVault.key-loss.js
npx hardhat test test/SafumodeMonitor.e2e.js
```

The package name and scripts are defined in `package.json`; the network and compiler settings are in `hardhat.config.js`. Test artifacts are generated under Hardhat's normal `artifacts/` and `cache/` paths.

## What the checks prove

A passing run shows that this revision behaves as asserted under Hardhat, Node, the included fixtures, and the tested fault injections. Manifest tests show that local code, constructor evidence, and build inputs can be tied to a local deployment. CLI tests show that explicit local-only gates, canonical bundle checks, signature recovery, simulations, and provider binding are enforced in the tested calls. Monitor tests show deterministic recovery behavior for the injected filesystem and RPC failures. Browser tests show the checked-in client fails closed for the scenarios constructed by the harness.

These are repository tests, not an audit. Most tests execute JavaScript reference workflows around a single EVM implementation. A defect shared by contract code and test assumptions can still pass.

## Known untested production paths

No test deploys to BNB Chain mainnet, testnet, or another public network. The manifest deployment and transaction libraries intentionally reject nonlocal use. There is no test of public mempool behavior, finality policy, congestion, fee estimation, replacement transactions, RPC rate limits, load-balanced RPC inconsistency, or long chain reorganization.

No test uses real hardware wallets, multisignature products, air-gapped transfer media, production secrets, operator access control, separate machines, or a real approval ceremony. Generated wallets and Hardhat accounts do not test key generation quality, backup, theft, permanent loss, device compromise, or human verification of typed data.

No test provides exhaustive Solidity fuzzing, symbolic execution, formal verification, high-volume invariant runs, gas-limit stress, or an independent security review. The deterministic state machine uses three seeds and 125 steps per seed.

No test establishes compatibility with a production token set. Included mocks cover conventional transfers, false returns, fees, and one callback pattern. Upgradeable, rebasing, reflective, denylisted, pausable, malicious balance-reporting, unusual return-data, and other nonstandard deployed tokens remain outside any supported policy.

The monitor tests use a local chain and controlled fault injection. They do not test a real archival provider, months of history, sustained event volume, filesystem exhaustion and recovery under an actual service manager, host crash semantics, backup restore, journal archival, multi-provider comparison, stdout shipping, pager delivery, escalation, acknowledgement by another person, or incident remediation.

The browser test uses one Chrome-compatible engine and a temporary local allowlist. It does not test a hosted origin, TLS, cache or CDN behavior, content security policy deployment, browser extension interference, hostile RPC infrastructure, mobile browsers, accessibility conformance, or supply-chain integrity of the vendored browser library.

CI runs on one Linux image and Node 22. Local success on macOS or another Node release adds useful portability evidence but does not expand the workflow's declared CI matrix. There are no performance, soak, migration, upgrade, or disaster-recovery tests.

Review [THREAT-MODEL.md](THREAT-MODEL.md), [PROTOCOL.md](PROTOCOL.md), and the release blockers in [AUDIT-READINESS.md](../AUDIT-READINESS.md) before interpreting test results as evidence for any deployment decision.
