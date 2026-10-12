# SAFUMODE Authorization Vault

SAFUMODE is an educational EVM custody prototype and a static, read-only browser for its state. The repository is **unaudited, not production-ready, and has no endorsed mainnet deployment**.

## Current security design

The vault separates an everyday funding/relay wallet from two signing authorities:

- **Deposits are permissionless.** Depositing or relaying a transaction grants no withdrawal authority.
- **Withdrawal authorizer:** signs withdrawals and immediate trust revocations.
- **Recovery authorizer:** can perform emergency recovery only to the immutable recovery recipient. It also participates in trust additions, authority rotation, and resume authorization.
- **Untrusted withdrawals are delayed.** A withdrawal-authorizer-signed exit to an untrusted address is queued for the immutable non-zero `delay`. Either current authority can cancel it before execution.
- **Trusted recipients are exceptional.** Adding one requires matching EIP-712 signatures from both authorities and delayed activation. A primary-authorizer-signed revocation is immediate. Per-recipient sequential nonces prevent replay and skipped authorizations.

### Rotation and veto

Authority rotation is 2-of-2: both current authorities sign the same replacement pair, and activation waits for `delay`. Either current authority can veto a pending rotation unilaterally. Old authorities are marked retired and cannot later be installed again. Activation increments `authorityEpoch`; this invalidates grants and queued state tied to the previous epoch rather than iterating over every recipient or request.

This deliberately does **not** solve loss of either authority: scheduling a rotation requires both current signatures.

### Pause

Either current authority can pause unilaterally. While paused, outflows and trust additions/activations are blocked. Resuming requires matching signatures from both authorities. Pause state does not replace monitoring, key security, or operational response.

### Recovery

A recovery-authorizer-signed recovery sends assets only to the immutable `recoveryRecipient`; the caller cannot select another destination. It bypasses the normal withdrawal delay, but like every outflow it is blocked while the vault is paused. This is a deliberate emergency path and a concentrated trust assumption.

## Read-only, unverified UI

The static UI accepts a vault address, expected chain ID, and either an explicit RPC URL or injected provider. It reads authorities, native balance, pause state, authority epoch, recipient trust state, and recent events. It checks the reported name/version and internal EIP-712 domain consistency.

Those checks **do not authenticate deployed bytecode**. A user-selected or malicious RPC can fabricate code and responses. The repository's deployment manifest workflow is deliberately local-only and is not consumed by the UI or a public-chain registry. Consequently:

- all signing and transaction flows are disabled;
- displayed values are explicitly an unverified RPC preview;
- the UI is not a wallet, relayer, monitor, or custody service.

Run the static UI locally with:

```sh
npm run dev
```

## Local verification

Contract tests:

```sh
npm test
```

Actual browser integration test:

```sh
npm run test:e2e:ui
```

The integration command compiles the existing contract, chooses unused localhost ports, starts an ephemeral Hardhat node, generates throwaway in-memory authority/recipient accounts, deploys and funds a vault, establishes a trusted recipient, pauses the vault, and serves the real UI. Headless Chrome then enters the vault address, chain ID, and localhost RPC and verifies that displayed authorities, balance, pause state, authority epoch, and trusted-recipient lookup equal direct on-chain reads. Processes are stopped afterward.

The test never reads a private-key environment variable, contacts a public RPC, or uses mainnet. Hardhat's local deployer is a publicly known development account; all vault authorities are newly generated test-only wallets and are never persisted. Chrome is discovered in common locations; set `CHROME_PATH` if it is installed elsewhere.

### Local operator drill

Run the complete transaction lifecycle against an ephemeral in-process Hardhat chain:

```sh
npm run operator:drill
```

The drill deploys and funds a fresh vault, creates throwaway authority and recipient keys in memory, prepares EIP-712 typed data, signs it with offline `Wallet` objects, and uses a separate unlocked Hardhat development account only as the local relayer. It asserts each state transition while exercising trust scheduling and activation, recovery-authority pause, two-authority resume, trusted withdrawal, delayed withdrawal scheduling and cancellation, fixed-recipient recovery, and delayed authority rotation. It prints a non-secret run summary on success. `npm run test:drill` runs the same scenario as a focused test.

The command is intentionally constrained to Hardhat chain ID `31337`; relay validation accepts only a loopback URL and verifies the checked-out build fingerprint and deployed runtime. It does not read environment private keys, persist generated keys, start or contact an external RPC, or use a user wallet. Every invocation begins from a fresh in-process Hardhat network, so the drill is reproducible and leaves no deployment behind.

### Reproducible local deployment manifest

This workflow accepts only chain ID `31337` and loopback RPC verification. It uses Hardhat's public development accounts (deployer account 0; constructor roles accounts 1–3), never a user wallet. Start a clean node, then deploy and verify in other terminals:

```sh
npx hardhat node
npm run manifest:deploy:local
npm run manifest:verify:local
npm run test:manifest
```

The default file is `deployments/hardhat-local.json`. Override output with `SAFUMODE_MANIFEST`; pass a manifest path and loopback URL to verification as positional arguments, for example `node scripts/verify-local-manifest.js ./copy.json http://localhost:8545`. `SAFUMODE_LOCAL_DELAY` may override the default `3600` seconds and is recorded in the manifest.

The manifest pins chain ID, checksum address, actual runtime-code Keccak-256, normalized constructor parameters, deployment transaction/block, full solc build version/settings, compiler-input and source hashes, bytecode-template hashes, lockfile hash, and an aggregate build fingerprint. Verification checks the RPC chain and runtime, reads immutable/initial constructor state from the contract, and compares the checked-out local build. It fails closed on mismatch. This is reproducibility evidence for an ephemeral test chain—not an audit, public deployment attestation, or defense against a malicious RPC.

## Release limitations

This is a prototype release, not a security product:

- no professional audit, formal verification, bug bounty, or production hardening;
- no mainnet/testnet deployment, public verified artifact, or pinned UI manifest (only local test-chain manifest tooling);
- no transaction-building/signing UI, relayer, indexer, alerting, continuous monitoring, or incident-response service;
- no upgrade or mutable administrator path; constructor choices (including delay and recovery recipient) are permanent;
- rotation requires both surviving current authorities and cannot recover a lost authority;
- recovery authority remains powerful because it can immediately move funds to the fixed recovery recipient;
- browser/RPC output is untrusted and should not be used as proof of contract identity;
- token compatibility and real operational key-management assumptions are not exhaustively validated.

Review the Solidity and tests directly before experimentation. Do not place real assets or real keys in this prototype.
