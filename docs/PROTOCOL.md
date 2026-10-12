# AuthorizationVault protocol

## Scope

`AuthorizationVault` is a non-upgradeable custody contract controlled through EIP-712 signatures. Transaction senders are relayers, not administrators. Any address may submit a correctly signed operation or invoke a permissionless activation or execution function.

The contract holds native currency and ERC20 balances. It separates ordinary authorization from recovery authorization, makes trust additions and authority rotation wait for a constructor-set delay, and gives either authority a unilateral stop. The source calls the native asset BNB in one comment, but the actual behavior is the chain's native currency.

This document describes `contracts/AuthorizationVault.sol` as written. It does not infer an off-chain quorum, an upgrade path, or asset support beyond the checks in that contract.

## Roles and immutable configuration

| Value | Set at deployment | Meaning |
|---|---:|---|
| `authorizer` | Yes, then rotatable | Signs ordinary withdrawals, trust revocations, one side of trust additions, pause or resume, and one side of rotation. |
| `recoveryAuthorizer` | Yes, then rotatable | Signs recovery transfers, cancellations, one side of trust additions, pause or resume, and one side of rotation. |
| `recoveryRecipient` | Yes, immutable | Sole destination of `recover`. It cannot be changed by rotation. |
| `delay` | Yes, immutable | Waiting period for trust additions, delayed withdrawals, and authority rotation. |

All three constructor addresses must be nonzero. The two authorities must differ. `delay` must be nonzero, and `block.timestamp + delay` must fit in `uint64` at deployment. The same representability check is repeated whenever a delayed timestamp is created.

There is no owner, connected-wallet administrator, upgrade function, arbitrary call function, or mechanism to replace only one authority.

## Signature domain and encoding

Every signed instruction uses this EIP-712 domain:

```text
name:              "Authorization Vault Prototype"
version:           "1:<authorityEpoch>"
chainId:           current block.chainid
verifyingContract: this vault address
```

`BASE_VERSION` is `"1"`. At deployment, `authorityEpoch` is zero and `VERSION()` is `"1:0"`. Each successful authority rotation increments the epoch, changing the domain immediately. A signature is therefore bound to the exact chain, vault, epoch, type, and fields.

Signatures must be exactly 65 bytes, use `v` 27 or 28, and have a low `s` value. Contract-wallet signatures under ERC-1271 are not supported. Deadlines are inclusive: a signature is accepted when `block.timestamp == deadline` and rejected only when the timestamp is greater.

The signed structures are:

```text
Withdraw(address asset,address to,uint256 amount,uint256 nonce,uint256 deadline,bool immediate)
SetTrusted(address account,bool trusted,uint256 nonce,uint256 deadline)
Cancel(bytes32 requestId,uint256 nonce,uint256 deadline)
Recover(address asset,uint256 amount,uint256 nonce,uint256 deadline)
SetPaused(bool paused,uint256 nonce,uint256 deadline)
RotateAuthorities(address authorizer,address recoveryAuthorizer,uint256 nonce,uint256 deadline)
CancelRotation(uint256 nonce,uint256 deadline)
```

`address(0)` denotes native currency only in asset fields. The `immediate` value is part of the withdrawal signature: `true` is used by `withdrawTrusted`, and `false` by `scheduleWithdrawal`.

## Nonce systems

The contract deliberately has several independent nonce systems.

| Namespace | Rule | Used by |
|---|---|---|
| `authorizerNonceUsed[nonce]` | Arbitrary unused values; marked used after verification | `withdrawTrusted`, `scheduleWithdrawal`, and authorizer-signed `cancelWithdrawal` |
| `recoveryNonceUsed[nonce]` | Arbitrary unused values; marked used after verification | `recover` and recovery-signed `cancelWithdrawal` |
| `trustNonce[account]` | Must equal the account's current value plus one | `scheduleTrust` and `revokeTrust` |
| `controlNonce` | Must equal the global current value plus one | `setPaused` for both pause and resume |
| `rotationNonce` | Must equal the global current value plus one | `scheduleRotation`; `cancelRotation` refers to the already consumed scheduling nonce |

The primary cancellation and withdrawal paths share the authorizer nonce bitmap. Recovery cancellation and recovery transfer share the recovery bitmap. A nonce used for one operation in the same bitmap cannot be reused for the other operation.

A reverted transaction rolls back nonce changes. This includes a transfer that fails after `_authorize` has marked a nonce, because the whole call reverts atomically. Sequential counters also remain unchanged if their call reverts.

Rotation changes the EIP-712 domain but does not clear any nonce mapping or sequential counter. A previously used numeric bitmap nonce remains used after rotation. Fresh signatures must use the new epoch domain.

## Pause behavior

`setPaused(true, byRecovery, nonce, deadline, signature, secondSignature)` changes an unpaused vault to paused. `byRecovery` selects which current authority must have made `signature`; the other signature argument is ignored. Either authority can therefore pause alone.

`setPaused(false, ..., nonce, deadline, signature, secondSignature)` changes a paused vault to unpaused. `signature` must be from the current authorizer and `secondSignature` from the current recovery authorizer over identical typed data. The `byRecovery` argument has no effect on resume verification.

Both transitions require exactly `controlNonce + 1`, reject a no-op state transition, and update the counter only on success. Pause and resume signatures use the current epoch domain.

The following table is the source-level pause matrix.

| Function | Callable while paused? | Effect |
|---|---:|---|
| Native `receive` and `depositToken` | Yes | Assets may continue to enter. |
| `setPaused` | Yes | Permits the valid opposite transition. |
| `cancelWithdrawal` | Yes | Either authority may cancel an existing live request. |
| `cancelRotation` | Yes | Either authority may veto the current pending rotation. |
| `revokeTrust` | Yes | The authorizer may revoke trust and erase a pending addition. |
| `withdrawTrusted` | No | Immediate outflow is blocked. |
| `scheduleWithdrawal` | No | New delayed outflow is blocked. |
| `executeWithdrawal` | No | Mature requests remain stored but cannot execute. |
| `recover` | No | Recovery outflow is blocked. |
| `scheduleTrust` and `activateTrust` | No | Trust additions cannot be scheduled or activated. |
| `scheduleRotation` and `activateRotation` | No | Rotation cannot be scheduled or activated. |

Pause does not erase pending requests, pending trust additions, or a pending rotation. After a two-signature resume, still-current pending state can continue subject to its normal epoch, nonce, cancellation, and timing checks.

## Function behavior

### Native receipt

`receive()` accepts any native-currency amount from any sender and emits `NativeDeposited(from, amount)`. It remains available while paused. Native currency can also arrive without this function running, for example through forced balance transfer, in which case no deposit event is guaranteed by this contract.

### `depositToken(address token, uint256 amount)`

Any caller may deposit while paused or unpaused. `token` must be nonzero and contain code. The contract reads its own balance, calls `transferFrom(msg.sender, address(this), amount)`, reads its balance again, and returns and emits the nonnegative balance increase as `received`.

The call accepts tokens that return no data or the canonical 32-byte value `1`. A false return, malformed return, call revert, missing code, or malformed `balanceOf` result causes `TransferFailed`. If the measured balance falls, it causes `BalanceDecreased`.

Inbound fee-on-transfer tokens can be accepted because the event records net receipt rather than the requested amount. Acceptance on deposit does not imply that the token can later leave through an outbound path.

### `scheduleTrust(address account, ...)`

This function requires the vault to be unpaused, a nonzero account, `nonce == trustNonce[account] + 1`, and matching current-authorizer and current-recovery-authorizer signatures over `SetTrusted(account, true, nonce, deadline)`. On success it advances the account nonce and stores one pending addition with `executableAt = current timestamp + delay` and the current authority epoch.

A later valid schedule for the same account and next nonce overwrites the earlier pending addition. The earlier pending operation then cannot activate because its nonce no longer matches.

### `activateTrust(address account, uint256 nonce)`

Anyone may activate an addition while unpaused. The stored pending entry, supplied nonce, current `trustNonce`, and pending epoch must all agree. Activation is allowed at exactly `executableAt`, not before. It deletes pending metadata and records trust for the current epoch.

The original signature deadline is not checked again during activation. It only had to be valid when scheduled.

### `revokeTrust(address account, ...)`

The current authorizer alone signs `SetTrusted(account, false, nonce, deadline)`. The account must be nonzero and the nonce must be exactly the account's current nonce plus one. Revocation works even while paused, takes effect immediately, clears active trust, and deletes any pending addition and its epoch marker.

### `trusted(address account)`

An account is trusted only when its stored marker equals `authorityEpoch + 1`. Trust is not a timeless allowlist entry. Every successful authority rotation invalidates all active trust grants in constant time.

### `withdrawTrusted(address asset, address to, uint256 amount, ...)`

This is the immediate ordinary withdrawal path. It requires an unpaused vault, a destination trusted in the current epoch, an unused authorizer bitmap nonce, and a current-authorizer signature over `Withdraw(..., immediate=true)`. It then transfers the signed asset and amount and emits `WithdrawalExecuted` with a zero request ID.

No recovery signature and no delay apply. The trust check occurs before signature authorization. `to` cannot effectively be zero because zero is never trusted.

### `scheduleWithdrawal(address asset, address to, uint256 amount, ...)`

This is the delayed ordinary withdrawal path. It requires an unpaused vault, a nonzero destination that is not currently trusted, an unused authorizer bitmap nonce, and a current-authorizer signature over `Withdraw(..., immediate=false)`.

The request ID is `keccak256(abi.encode(domainSeparator, structHash))`. The request stores the asset, destination, amount, `current timestamp + delay`, status flags, and current authority epoch. The asset need not already be present, and no token interaction occurs during scheduling. A successful schedule consumes its authorizer nonce even if execution never occurs.

The signature deadline is checked only when scheduling. Execution may occur after that deadline. Because the request ID includes the epoch-specific domain separator and all signed fields through `structHash`, changing those values changes the ID.

### `executeWithdrawal(bytes32 requestId)`

Anyone may execute a live request while unpaused. It must exist, not be cancelled, not be executed, belong to the current authority epoch, and have reached `executableAt`. The boundary is inclusive. The function marks it executed before the external transfer, under the reentrancy guard. If transfer fails, the transaction revert restores the flag so execution can be retried later.

Execution does not re-check whether the destination has since become trusted. It follows the stored request. It also does not re-check the scheduling deadline.

### `cancelWithdrawal(bytes32 requestId, bool byRecovery, ...)`

Either authority can cancel a pending, unexecuted request, including while paused and including at or after maturity. `byRecovery` selects the expected signer and nonce bitmap. The signature is over `Cancel(requestId, nonce, deadline)`. Successful cancellation marks the request and consumes the selected authority's bitmap nonce.

Cancellation cannot be applied to a missing, already cancelled, or executed request. There is no separate cancellation grace period. At maturity, ordering decides the outcome: cancellation first prevents execution, while execution first prevents cancellation.

### `recover(address asset, uint256 amount, ...)`

This path requires an unpaused vault, an unused recovery bitmap nonce, and a current-recovery-authorizer signature over `Recover(asset, amount, nonce, deadline)`. The destination is always the immutable `recoveryRecipient`; it is not a signed or caller-supplied field. Recovery is immediate and has no timelock or authorizer approval.

### `scheduleRotation(...)`

Rotation requires an unpaused vault, exactly `rotationNonce + 1`, and signatures from both current authorities over the same `RotateAuthorities` data. Both proposed addresses must be nonzero and distinct. Neither may equal either current authority, and neither may have been retired by an earlier successful rotation.

A successful call advances `rotationNonce` and stores one pending pair with a delayed execution time. Scheduling a later valid rotation with the next nonce replaces the earlier pending pair. Rotation cannot be used to change only one role while retaining either current authority.

### `activateRotation(uint256 nonce)`

Anyone may activate while unpaused at or after the stored time. The pending nonce and current `rotationNonce` must both match. Activation deletes the pending entry, permanently marks both old authorities as retired, installs both new authorities, and increments `authorityEpoch`.

The epoch increment changes the signature domain and invalidates active trust, pending trust additions, and queued withdrawals from older epochs. The old queue records remain in storage but cannot execute. Existing bitmap nonces and sequential nonce counters are not reset. The immutable recovery recipient and delay do not change.

### `cancelRotation(bool byRecovery, ...)`

Either current authority may veto the pending rotation alone, even while paused and even after maturity if activation has not happened. The signature covers `CancelRotation(pending nonce, deadline)`. Cancellation deletes the pending pair but does not decrement `rotationNonce`, so the next schedule must use the next integer.

## Asset transfer rules

For native currency, the contract calls the recipient with exactly `amount` and empty calldata. A recipient revert or insufficient balance causes `TransferFailed`. Recipient code executes with available gas, while the nonreentrancy guard protects `depositToken`, `withdrawTrusted`, `executeWithdrawal`, and `recover` from reentering those guarded functions.

For ERC20 outflows, the token address must contain code and provide a `balanceOf(address)` call returning exactly 32 bytes. The contract records vault and recipient balances, calls `transfer(to, amount)`, then reads both balances again. Success requires the vault balance to decrease by exactly `amount` and the recipient balance to increase by exactly `amount`. A conventional zero transfer is accepted only if both balances remain unchanged. A positive transfer to the vault itself cannot satisfy both exact deltas.

Token calls may return no data or exactly 32 bytes containing `1`. Other return shapes or values fail. The exact-delta check rejects many fee-on-transfer, sender-fee, recipient-fee, rebasing, reflective, and otherwise balance-mutating behaviors. If the transfer or post-check fails, all token movement must revert with the transaction for a conforming EVM token call; the vault's nonce or executed flag also rolls back.

Tokens with denylisting, pausing, upgradeable behavior, callbacks, unusual balance accounting, malformed return data, or malicious implementations are not generally supported. A token can be accepted on deposit yet be impossible to withdraw. Direct token transfers to the vault bypass `depositToken` checks and events and do not establish support.

## Timing summary

The delay begins from the block timestamp of the successful scheduling transaction, not from signature creation. Trust activation, withdrawal execution, and rotation activation accept the exact `executableAt` timestamp. Signature deadlines are also inclusive.

Deadlines govern submission of signed calls. They do not expire already scheduled trust additions, withdrawal requests, or rotations. Pending operations have no automatic expiry and require activation, execution, cancellation, supersession, revocation, or an epoch change to become resolved or unusable.

## Events and state observation

Events describe successful transitions but should be checked against state when deciding what remains executable. Important state includes `paused`, both current authorities, the immutable recipient, `authorityEpoch`, `VERSION()`, all nonce systems, `pendingRotation`, `pendingTrust`, `requests`, and `trusted(account)`.

A successful `TokenDeposited` amount is measured net receipt. `WithdrawalExecuted` uses request ID zero for trusted immediate withdrawals. Recovery has its own `RecoveryExecuted` event. Rotation and trust scheduling events expose their exact activation timestamps.
