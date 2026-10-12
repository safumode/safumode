# Threat model

This is an unaudited local prototype, not production software.

## Authorities and trust

- A connected/funding wallet has no privilege. Anyone may deposit or relay a valid signed message.
- The offline **authorizer** signs withdrawals and immediate trust revocations. A separate offline **recovery authorizer** can recover assets only to the fixed recovery recipient. Either authority can pause or cancel a queued withdrawal. Both must approve trust additions, unpause, and schedule authority rotation; either can veto a pending rotation.
- Adding a trusted recipient requires both authorities and the fixed delay. Revocation is immediate with an authorizer signature. Untrusted-recipient withdrawals are delayed and cancellable by either authority.
- Monitoring and timely cancellation remain operational requirements. At maturity, execution and cancellation are ordered by transaction inclusion.

## Emergency controls and rotation

Either authority can pause the vault with an EIP-712 signature. While paused, new trust additions, trust activation, withdrawal scheduling/execution, trusted withdrawals, and recovery outflows are blocked. Deposits, trust revocation, withdrawal cancellation, rotation scheduling/activation, and unpause remain available. This deliberately preserves defensive actions. Unpause requires fresh signatures from **both** current authorities and a strictly increasing control nonce, so a compromised authority cannot resume alone.

Authority rotation requires both current authorities, a strictly increasing rotation nonce, a fresh pair of authority addresses, and the same fixed delay used for withdrawals. During that delay, either current authority can unilaterally cancel the pending rotation with a signed `CancelRotation` veto. Both roles rotate together: neither current address may be carried into the new pair. Activation is permissionless after the delay and may occur while paused. Activation increments `authorityEpoch`; `VERSION()` exposes `1:<epoch>`, binding every EIP-712 signature to the active authority epoch. Thus even unsubmitted, otherwise-valid old signatures become invalid immediately. Pending trust additions and queued withdrawals record their scheduling epoch and cannot activate/execute after a rotation. Active trusted-recipient grants are also epoch-tagged and all become invalid in O(1) when the epoch changes; the new authorities must explicitly re-establish them. `pendingTrustEpoch(account)` exposes whether a pending trust addition belongs to the current epoch. Retired authority addresses can never be installed again. Rotation should be scheduled well before planned key retirement, and consumers must read `VERSION()` rather than hard-code it.

Rotation deliberately does **not** permit one authority to replace a lost counterpart. A unilateral loss-recovery path would turn compromise of either key into the power to appoint the other role and then obtain full control, defeating separation of duties. If the authorizer is lost, the recovery authority can still move funds only to the immutable recovery recipient for migration. If recovery is lost, the authorizer can use existing trusted recipients or delayed withdrawals to migrate assets. If both are lost, funds are stranded. Operational controls must therefore include tested backups, independent custody, monitoring, and a migration runbook.

## Signature and execution protections

Signatures bind every action field, chain ID, vault address, name/version, nonce, deadline, and withdrawal mode. Primary and recovery actions use separate nonce bitmaps; trust changes use strictly increasing per-recipient nonces; pause and rotation have dedicated strictly increasing nonces. Low-`s` ECDSA checks reject malleability. Deadlines are inclusive (`timestamp == deadline` is valid), as are timelock boundaries.

Nonce/state changes occur before external withdrawal calls and roll back on transfer failure. A reentrancy guard protects every value-moving withdrawal/recovery path and token deposits. Token calls require deployed code and either no return data or canonical ABI `true`; false, short, malformed, and non-canonical results become `TransferFailed`.

`depositToken` measures the vault's token balance before and after `transferFrom`, returns the delta, and emits that **net received amount**. This removes misleading fee-on-transfer deposit events. It is not an internal accounting ledger.

## Limits / exclusions

- ECDSA/secp256k1 is **not quantum-safe** and does not reproduce Bunker LM-OTS/day-key semantics.
- No audit, formal verification, upgrade path, key-management implementation, monitor, deployment, oracle, multisig, account abstraction, or UI assurance is provided. The web UI is only a read-only unverified-contract preview: user-supplied RPC responses cannot prove code identity, no deployment hash/manifest is pinned, and all signing flows are disabled.
- Malicious tokens can have arbitrary semantics. Balance-delta accounting assumes `balanceOf` is callable, returns one canonical 32-byte integer, and is internally consistent across the transaction. Rebasing, reflection, callback, denylist, or unusual transfer tokens can still fail or produce surprising deltas. Direct token transfers produce no vault deposit event.
- Scheduled amounts are not reserved; competing valid withdrawals or token behavior can make later execution fail.
- The recovery recipient and delay remain immutable. Compromise of the primary can eventually route funds by establishing a trusted recipient with recovery cooperation, or via delayed withdrawals; compromise of recovery can route funds only to the fixed recovery recipient. Compromise of both authorities gives full control.
- Timestamp manipulation within normal validator bounds, BNB Chain consensus/security, and relayer availability are assumed. Relayers can omit transactions but cannot alter signed actions.
