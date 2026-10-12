# Threat model

This is an unaudited local prototype, not production software.

## Authorities and trust

- A normal connected/funding wallet has no privileged method; it can deposit BNB or approved BEP20 tokens and relay signed messages.
- The **authorizer** is intended to be kept offline. It signs EIP-712 trust-list changes, immediate trusted-recipient withdrawals, and delayed untrusted-recipient withdrawals.
- A separate **recovery authorizer** can cancel queued withdrawals and invoke break-glass recovery. Recovery can transfer only to the immutable recovery recipient. Compromise of either signer can still cause loss (the primary signer via trusted-recipient setup; recovery via recovery transfer).
- Untrusted-recipient withdrawals have a fixed delay, during which either signer can authorize cancellation. Monitoring and timely relay of cancellation are operational requirements.

## Protections

Signatures bind action fields, chain ID, contract address, name/version, nonce, deadline, and immediate/delayed mode. Primary-authority actions share one nonce bitmap and recovery-authority actions share another; trust changes instead use a strictly increasing per-recipient nonce. Low-`s` ECDSA checks reject malleable signatures. Nonces/state are updated before external withdrawal calls (and roll back if the transfer fails); a reentrancy guard covers all value-moving withdrawal/recovery paths. Token calls require contract code and accept only empty or the canonical ABI-encoded `true` word; false, short, and malformed/non-canonical returns are normalized to `TransferFailed`.

The deadline and timelock comparisons are intentionally inclusive: a signature is valid in a block whose timestamp equals its deadline, and a queued operation is executable when `block.timestamp == executableAt`. Cancellation has no cutoff at maturity. At or after maturity, cancellation and execution are a transaction-ordering race: whichever valid transaction lands first makes the other fail with `RequestMissing`.

## Limits / exclusions

- ECDSA uses secp256k1 and is **NOT quantum-safe**. This is not equivalent to Bunker's LM-OTS design and does not preserve its post-quantum/day-key semantics.
- No audit, formal verification, upgrade path, key generation/storage, UI, monitor, deployment, oracle, multisig, account abstraction, or fee-on-transfer/rebasing token accounting is provided.
- Only conventional BEP20 behavior is in scope. Malicious tokens may have arbitrary behavior. Fee-on-transfer deposits are accepted, but `TokenDeposited.amount` is the requested transfer amount rather than the net amount received; the vault has no internal token ledger and can transfer only its actual balance. Rebasing-token semantics are likewise not accounted for. Scheduled amounts are not reserved, so competing valid withdrawals can make execution fail.
- The immutable authorities/recipient/delay deliberately reduce administrative attack surface but require redeployment to rotate them. Lost signer material can strand funds unless recovery remains usable.
- Timestamp manipulation within normal validator bounds and BNB Chain consensus/security are assumed. Relayers can censor by omission but cannot alter signed actions.
