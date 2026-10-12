# Architecture

SAFUMODE has one custody contract and several separate ways to observe or rehearse it. The contract is the only component that can enforce withdrawals. The browser and monitor cannot recover funds. The local transaction scripts cannot submit to a public chain.

## Contract

`contracts/AuthorizationVault.sol` holds native currency and ERC20s. Its constructor sets the two signing authorities, one permanent recovery destination, and a permanent nonzero delay. There is no proxy, upgrade administrator, or general purpose arbitrary call. Anyone can submit a signed instruction, but the contract recovers its signer against the current EIP 712 domain and role. It stores nonces, pending trust additions, withdrawal requests, authority rotations, and a paused flag.

`authorityEpoch` changes when the authority pair rotates. That change alters the signature domain and invalidates earlier trust and queued operations without walking every entry in storage. The recovery destination does not rotate with the signers. The [protocol description](PROTOCOL.md) has the actual field and state rules.

## Offline preparation and local relay

`scripts/safumode-cli.js` exposes preparation, signed relay, and unsigned lifecycle commands. Preparation constructs typed data from a local deployment manifest. It does not connect to an RPC or sign. A separate signer must inspect the fields and produce a signature. Relay checks the signature, manifest, live contract state, chain, nonce, and deadline, then simulates the exact call before any optional broadcast. Broadcast is limited to an explicitly selected loopback Hardhat RPC and development relayer. Permissionless activation and withdrawal execution have their own local commands.

This separation is operational, not a claim that an offline computer is automatically safe. A copied typed data bundle can be signed or submitted somewhere else. The tool refuses to prepare against nonlocal manifest identities, but the operator still has to protect signing devices and inspect what they sign. Details and runnable local examples are in [Operator notes](OPERATOR.md).

## Deployment identity

`scripts/deployment-manifest.js` records the compiler and input fingerprints, runtime code hash, creation transaction, constructor arguments, and chain identity for a disposable local deployment. Verification compares the deployed runtime and creation evidence with the checked out build. A valid rotation changes current authorities without changing their original constructor values, so the verifier checks both facts in their respective places.

A local manifest is not a public endorsement. `web/deployment-allowlist.json` intentionally contains no production addresses. The browser fetches this allowlist and fails closed when it is missing, malformed, or does not match its pin. It cannot prove a dishonest RPC is telling the truth.

## Browser

`web/app.js` renders read only status, recipient policy, and recent activity at a consistent chain snapshot. Signing is disabled. A refresh repeats identity checks; if a pin no longer matches, the browser withdraws its earlier verified display rather than carrying stale recipient claims forward. The browser integration test uses a temporary local allowlist fixture. That fixture is not shipped as a production pin.

## Monitor and local alert evidence

`scripts/safumode-monitor.js` scans a pinned vault through an RPC and compares reported logs to receipts and block headers before advancing its checkpoint. A single owner lock prevents concurrent processes from writing the same checkpoint, spool, and journal. Alerts are written to a local spool, sent to stdout, and durably appended to a journal before checkpoint progression. Reorg handling uses retained block hashes and may legitimately produce a replacement alert.

`scripts/safumode-alerts.js` reads that journal and writes acknowledgements to a separate sidecar. It never modifies the journal. Neither the journal nor the acknowledgement sidecar is a managed pager, a second independent data source, or a record of human remediation. For restart and failure semantics, read [Monitor notes](../SAFUMODE.md).

## CI and what it cannot establish

GitHub Actions compiles and exercises contract tests, the local operator drill, browser integration, lifecycle CLI integration, and the static build. All chain writes in those jobs use throwaway Hardhat state. CI cannot stand in for a code audit, a live chain verification, real signer custody, or an alert response exercise. The [testing notes](TESTING.md) separate coverage from those open questions.
