# SAFUMODE — independent review request draft

Status: **UNAUDITED, NOT DEPLOYED, NO REAL FUNDS.** This is an original EVM prototype informed by Bunker's general wallet-separation idea, not a port of its LM-OTS implementation; no quantum-safety claim.

## Contract scope (freeze exact revision before requesting a quote)
- `contracts/AuthorizationVault.sol`, Solidity compiler settings, lockfile, deploy constructor parameters.
- Native BNB and conventional BEP-20 handling; actual-received deposits; token callbacks and nonstandard token behavior.
- EIP-712 domains, chain/contract/authority epoch, signature validation, nonce/deadline and queued-effect invalidation.
- Untrusted timed exits, 2-of-2 delayed trusted-recipient additions, immediate revocation, emergency pause and 2-of-2 resume.
- Recovery-signature immediate payout to immutable recovery recipient, delayed 2-of-2 authority rotation with unilateral veto; irreversible key loss.
- Chain timestamp/order assumptions, recovery destination and paused pending effects.

## Current verified local checks
- `npm test` — unit, adversarial and bounded property tests.
- `npm run test:e2e:ui` — ephemeral Hardhat deployment plus actual headless browser read-only UI, no public chain.
- `npm run test:manifest` — local manifest generation/verification integration tests, including wrong-chain, wrong-code, wrong-parameter, and wrong-build rejection.
- `npm run operator:drill` — deterministic local-chain offline-sign/local-relay lifecycle with generated development keys; not a real key-custody drill. CI runs this alongside the tests.
- `npm run build` — static site.
- The monitor cross-checks queried logs against receipts and now rejects a receipt belonging to another transaction in the same block. Checkpointed stdout is not durable downstream delivery; a crashed or disconnected alert consumer can still miss an alert. Production needs an acknowledged durable alert queue/spool and a tested on-call response before treating monitoring as a safeguard.
- Independent agent review identified and prompted fixes to rotation stale-signature/queue behavior, absent veto, active trust persistence, misleading UI identity claims. This **is not an independent security audit**.

## Release blockers (not optional polish)
1. Define supported assets and safe-operation procedure. Fee-on-transfer deposits report net amount but outgoing transfers do not guarantee recipient's net amount. Rebasing, blacklist and malicious token behavior are excluded.
2. Establish secure key-generation/storage, separate signer custody, independent monitoring/alerts, transaction relaying, tested recovery drill and incident response. No live signing workflow exists in the website; do not ask users to sign or deposit.
3. Decide signer loss model and whether EOA-only authorities and immutable recovery recipient are acceptable. 2-of-2 rotation cannot recover a lost key; single recovery signer has immediate fixed-destination value-moving power.
4. Finish higher-volume fuzz/invariant testing and third-party review of contract + operational security; remediate findings and obtain independent re-review. A paid engagement alone is not an approval badge.
5. Freeze commit, compiler/build inputs, deployment manifest, bytecode identity and audited scope. Before enabling a read-only address as 'verified' or wallet signing, independently pin code identity and account for constructor immutables/metadata; arbitrary RPC/contract self-report is not proof.
6. Mainnet deployment, ownership of operational keys, payment for audit, public-source publication, domain cutover and custody activation each require explicit approval. No audit report or launch claim exists now.

## Local deployment evidence (not a release deployment)

`npm run manifest:deploy:local` targets only a separately running `localhost` Hardhat node with chain ID 31337 and uses only its known development accounts. `npm run manifest:verify:local` refuses non-loopback RPC URLs and validates chain, address/code hash, constructor-backed state, compiler inputs/settings, bytecode templates, source and lockfile hashes, and the aggregate build fingerprint. See the README for commands. The generated `deployments/hardhat-local.json` is ephemeral evidence and must not be represented as a public deployment, audit result, or UI trust anchor.

## Auditor handoff
Provide source commit, bytecode/build manifest, deployed-network assumptions, privileged-role matrix, signature schemas, trust/rotation/queue invariants, test commands, supported/excluded assets, monitoring and incident playbook. Request fixed-scope written findings and remediation review, publish final report with disclosed residual risks only after completion.
