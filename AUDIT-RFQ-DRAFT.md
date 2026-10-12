# SAFUMODE independent review — no-commitment quote draft

Status: UNSENT. Private repository; no public deployment, live funds, audit, or production signing.

We seek a fixed-scope independent security review of an original BNB/EVM vault prototype and its operational components. Please quote two scopes separately: (A) Solidity contract and deployment/build verification; (B) contract plus offline EIP-712 preparation, guarded local relay, read-only browser identity, and event monitor with local alert spool/journal. Please include estimated schedule, required freeze period, deliverables, written findings, remediation re-review, and whether a final report may be published after remediation. Identify any excluded off-chain components explicitly.

Core risks to examine: unilateral pause/rotation veto, two-key trust addition and delayed activation, authority rotation invalidation of queued effects and active trust, immutable recovery recipient, EIP-712 signature/nonce/domain handling, unusual BEP-20 behavior and outbound amount assumptions, RPC deception, reorg/log/receipt consistency, durable local alert evidence versus actual downstream notification, key-loss/recovery limitations, and deployment bytecode identity.

We can share the private repo and exact frozen commit through a controlled access channel after confidentiality and access arrangements are agreed. Please do not treat internal tests, CI, or this request as an audit. No deposits or live vault are authorized. Contact details and repository access are deliberately omitted from this draft; founder approval is required before submission or access grant.

Existing technical scope: AUDIT-READINESS.md, THREAT_MODEL.md, SAFUMODE.md, contracts/AuthorizationVault.sol, scripts/safumode-tx.js, scripts/safumode-cli.js, scripts/safumode-monitor.js, scripts/deployment-manifest.js, scripts/operator-drill.js, tests and lockfile.

Potential official intake channels (confirm exact submission before use):
- https://www.zellic.io/contact
- https://trailofbits.com/contact/
- https://www.openzeppelin.com/request?id=security_audits
