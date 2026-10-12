# Independent-review readiness (draft, not an audit)

Status: NOT READY TO SUBMIT AS FINAL. No live funds, deployment, or third-party audit. Bunker's MIT source was studied as a conceptual reference; this EVM prototype is not a port of its LM-OTS system and must not inherit its security claims or brand.

## Proposed scope
- `contracts/AuthorizationVault.sol` and its exact Solidity compiler/dependency lockfile and deployment parameters.
- Deposits of native BNB and conventional BEP-20s; authorizer/recovery EIP-712 signatures; nonce and deadline handling; trust-add co-signatures and activation delay; revocation; withdrawal queues, execution, cancellation, break-glass recovery; token callbacks/reentrancy; role compromise.
- BNB chain-ID and contract-address separation; timestamp and transaction-ordering assumptions; all token balance and event semantics.
- Separately commissioned cryptography review only if replacing ECDSA with one-time/post-quantum signatures. This draft offers NO quantum resistance.

## Release blockers before paying for the final contract audit
1. Decide whether the product requires Bunker-equivalent day-key rotation and offline recovery. Current prototype has immutable ECDSA authorities: lost/compromised keys require asset migration, not an in-place rekey.
2. Specify the recovery threat model: recovery signer can immediately transfer to immutable recovery recipient; document how that recipient is controlled and monitored. Decide ERC-1271/multisig support before freezing code.
3. Extend tests and fuzz/invariants: every signature type, nonce race, queued-withdrawal ordering, balance exhaustion, failed transfers, malicious/no-return/fee tokens, token reentrancy, native recipient reentrancy, boundary timestamps, chain replay, exact deployment parameter constraints.
4. Formalize supported asset list and reject or clearly exclude rebasing/fee-on-transfer/blacklist/frozen tokens. Freeze event accounting semantics.
5. Design and exercise actual offline signing, secure key generation/storage and recovery workflow, independent watcher/alerting, and incident-response runbook. A Solidity-only audit cannot certify these.
6. Freeze a tagged commit and bytecode reproducibility manifest; publish full threat model, test commands, known limitations, deployment addresses and admin/upgrade policy. Request a written fixed-scope proposal from a real independent auditor; remediate findings and commission a re-review.

## Audit-request deliverables
- Frozen Git commit, compiler version, lockfile, deployment scripts and parameters.
- Architecture and privileged-role/asset-flow diagrams.
- Invariants: connected wallet has no withdrawal authority; no untrusted payout before expiry; trust addition needs both authorities plus delay; revocation supersedes pending activation; signatures cannot replay on another chain/contract/nonce; cancellation prevents execution; recovery destination immutable.
- Full test suite and coverage/fuzz reports, scope and excluded token behavior, threat model, bug-bounty contact.
- Independent report and remediation commit(s), with any remaining findings disclosed. Do not display an audit badge before a completed published report.
