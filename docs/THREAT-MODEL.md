# AuthorizationVault threat model

## Purpose and security boundary

This model covers the deployed `AuthorizationVault` contract, its two ECDSA authority keys, its immutable recovery recipient, relayers, and assets held at the contract address. It describes guarantees visible in `contracts/AuthorizationVault.sol` and failure cases exercised by the current tests and key-loss runbook.

The contract enforces authorization and timing. It does not secure private keys, validate the human intent behind a signature, judge whether a recipient is safe, guarantee token correctness, operate monitoring, or supply transaction fees. It is not upgradeable and has no administrator able to repair state.

## Protected assets and objectives

The protected assets are native currency and ERC20 balances at the vault address. The relevant control state includes current authorities, trusted-recipient grants, queued withdrawals, pause state, pending rotation, the authority epoch, and nonce records.

The intended source-level objectives are:

1. An ordinary immediate outflow requires the current authorizer's signature and a destination trusted in the current epoch.
2. An ordinary outflow to a non-trusted destination requires the current authorizer's signature and the configured waiting period.
3. Adding trust requires both current authorities and the waiting period. The current authorizer can revoke it immediately.
4. Recovery authority can make an immediate outflow only to the immutable recovery recipient.
5. Either authority can stop outflows. Both current authorities are required to resume.
6. Replacing authorities requires both current authorities and the waiting period. Either current authority can veto before activation.
7. Rotation invalidates signatures and queued capabilities from the old authority epoch.
8. Successful ERC20 outflow requires exact vault debit and exact recipient credit for the signed amount.

These properties are conditional on normal EVM transaction atomicity, correct chain consensus, private-key integrity, and the behavior actually observable from token contracts.

## Actors and assumptions

| Actor or component | Assumed capability | Relevant limitation |
|---|---|---|
| Authorizer key holder | Can sign ordinary withdrawals, revocations, pause, cancellation, and half of dual-authority operations | Cannot call recovery as recovery authority, resume alone, add trust alone, or rotate alone |
| Recovery-authorizer key holder | Can recover to the fixed recipient, pause, cancel, and sign half of dual-authority operations | Cannot authorize ordinary withdrawals, resume alone, add trust alone, or rotate alone |
| Recovery recipient controller | Controls assets after successful recovery | Cannot change the on-chain recipient and receives no signing power merely from being the recipient |
| Relayer or public caller | Can submit signatures and call permissionless activation or execution functions | Cannot alter signed fields or satisfy missing signatures |
| Recipient | May be an EOA or contract and may execute code on native receipt or token callbacks | Cannot bypass required authorization merely by receiving assets |
| ERC20 contract | Controls its own transfer and balance-accounting behavior | May be incompatible or malicious; token support is not guaranteed |
| Block producer or sequencer | Can influence transaction ordering and block timestamps within chain rules | Cannot forge authority signatures under the cryptographic assumption |

Authority keys are assumed to be distinct, as deployment and rotation enforce distinct addresses. Operational independence is not enforced. The contract cannot tell whether both keys derive from one seed, are held by one person, or sign through compromised software.

## Signature and replay analysis

Each signature is bound to chain ID, contract address, contract name, and epoch-specific version. It is also bound to its EIP-712 type and every field in that type. A `Withdraw` signature cannot be interpreted as `Recover`; a recovery payload has no destination field; and changing amount, destination, asset, nonce, deadline, or immediate mode invalidates a withdrawal signature.

The implementation accepts only canonical 65-byte ECDSA signatures with low `s` and `v` 27 or 28. This blocks the high-`s` malleability form tested by the suite. It does not support smart-contract signers.

Replay protection differs by operation. Ordinary and recovery operations use separate used-nonce bitmaps. The numeric nonce does not need to be monotonic, but each value can succeed only once within its authority namespace. Trust, pause, and rotation use strict incrementing counters. Reverted calls do not consume nonces.

The authorizer's withdrawal and cancellation operations share one bitmap. The recovery authority's recovery and cancellation operations share another. Signing systems must not allocate the same nonce concurrently to operations sharing a namespace.

A rotation increments `authorityEpoch` and changes `VERSION()`, invalidating old-domain signatures immediately. Nonce state is retained across epochs. This retention means a nonce consumed before rotation cannot be reused by a new key, even though old signatures are already invalid because of the domain change.

Deadlines protect only submission time. The contract accepts a call at the exact deadline and rejects it after. Once a trust addition, withdrawal, or rotation is scheduled, its original signature deadline no longer limits activation or execution.

## Delay and transaction-ordering analysis

Trust additions, ordinary withdrawals to non-trusted destinations, and rotations receive `executableAt = scheduling block timestamp + delay`. They are executable at exactly that timestamp. The delay gives observers time to react, but the contract does not provide monitoring or automatic cancellation.

At a request's maturity, execution and cancellation can race. If cancellation is mined first, execution fails. If execution is mined first, cancellation fails without consuming its nonce. The same practical ordering issue applies to rotation activation versus a unilateral rotation veto.

A pause mined before an outflow prevents execution. A pause does not delete the pending operation. After a valid two-key resume, the operation remains available if it is otherwise live. A pending rotation may likewise activate immediately after resume if already mature and not vetoed.

Block timestamps are supplied by the chain under its consensus rules. The protocol relies on those timestamps for both deadlines and waiting periods. Applications should not treat a scheduled wall-clock estimate as stronger than the chain's timestamp semantics.

## Pause as containment

Either current authority can pause with the next global control nonce. Pause blocks trusted withdrawals, scheduling and execution of delayed withdrawals, recovery transfers, trust scheduling and activation, and rotation scheduling and activation.

Pause intentionally does not block deposits, trust revocation, withdrawal cancellation, rotation veto, or a properly co-signed resume. This permits containment and cleanup while preventing outflow.

Pause is not a key-recovery mechanism. Resume always requires both current authority signatures. Rotation also requires both current signatures and cannot be scheduled or activated while paused. Consequently, pausing after one key is permanently lost can make every contract-mediated outflow permanently unavailable.

## Key loss cases

The following matrix is exact for the contract's two authority roles. “Lost” means permanently unable to produce a signature and not assumed compromised.

| Vault state | Lost key | What remains possible | What is no longer possible |
|---|---|---|---|
| Unpaused | Authorizer | Recovery authority can call `recover` for native currency or a compatible ERC20, always to the immutable recovery recipient. It can pause and can cancel existing withdrawals or a pending rotation. | New ordinary withdrawals, trust revocation, trust addition, two-key resume, and authority rotation. Recovery cannot select another destination. |
| Unpaused | Recovery authorizer | Authorizer can schedule delayed withdrawals to any nonzero currently untrusted destination, execute them after the delay through any relayer, revoke trust, pause, and cancel existing withdrawals or a pending rotation. | Recovery transfers, new trust additions, two-key resume, and authority rotation. Immediate trusted withdrawal remains possible if an appropriate current-epoch trust grant already exists. |
| Paused | Authorizer | Deposits, recovery-signed cancellation, and recovery-signed rotation veto remain possible. | Every outflow, resume, trust addition or activation, and rotation scheduling or activation. Without restoration of the authorizer key, assets cannot leave through this contract. |
| Paused | Recovery authorizer | Deposits, authorizer-signed trust revocation, cancellation, and rotation veto remain possible. | Every outflow, resume, trust addition or activation, and rotation scheduling or activation. Without restoration of the recovery key, assets cannot leave through this contract. |
| Either state | Both authority keys | Existing valid signatures can still be submitted by anyone until their deadlines, subject to nonce, epoch, pause, and other checks. If unpaused, already scheduled withdrawals can also execute after maturity. If paused, deposits and any previously signed cancellation, rotation veto, or trust revocation that passes current checks can still be submitted. | No fresh signatures can be produced. Once outstanding signatures expire or are consumed, there is no path to rotate or resume a paused vault. |

Loss of the immutable recovery recipient's key or control is different from authority-key loss. The recovery authority may still authorize `recover`, but successful transfers go only to that inaccessible recipient. The authorizer can use ordinary withdrawal rules to send to another eligible destination while unpaused. The immutable recipient cannot be repaired by rotation.

A lost key cannot be replaced through single-key rotation. Rotation requires both current keys before the delay begins. Reusing the surviving signature in both slots, swapping role labels, or signing a different EIP-712 type does not satisfy verification.

## Key compromise cases

### Authorizer compromised, recovery authority intact

While unpaused, the attacker can immediately withdraw to any account already trusted in the current epoch. The attacker can also schedule delayed withdrawals to arbitrary nonzero untrusted destinations, revoke trust immediately, cancel pending withdrawals using authorizer nonces, veto pending rotation, and pause.

The attacker cannot add a new trusted recipient alone, use `recover`, resume alone, or rotate alone. The recovery authority can pause unilaterally if its pause reaches the chain first. It can cancel each observed queued withdrawal and can recover compatible assets to the immutable recipient while the vault remains unpaused. Once paused, even recovery is blocked, and resume still requires the compromised authorizer's signature. Containment therefore trades ongoing outflow risk for possible dependence on the compromised key to resume.

If the compromised authorizer has previously obtained valid recovery-authorizer co-signatures for trust or rotation payloads, those exact unexpired payloads can be submitted while unpaused. Operational response must inventory outstanding signatures, not only on-chain pending state.

### Recovery authorizer compromised, authorizer intact

While unpaused, the attacker can immediately recover any available native currency or compatible ERC20 to the immutable recovery recipient. The attacker cannot redirect recovery elsewhere. If the recovery recipient is secure and independently controlled, this constrains destination risk but can still disrupt custody, timing, and availability.

The attacker can also cancel queued withdrawals using recovery nonces, veto a pending rotation, and pause. It cannot authorize ordinary withdrawals, add trust alone, resume alone, or rotate alone. The authorizer may schedule delayed migration withdrawals while still unpaused, but the attacker can cancel them or pause before execution. There is no unilateral authorizer path that disables the compromised recovery key.

Outstanding authorizer co-signatures for trust or rotation remain relevant in this case. A compromised recovery signer can complete and submit an exact, still-valid dual-signature payload if it can obtain or already has the corresponding authorizer signature.

### Both authorities compromised

An attacker controlling both keys can perform every signed transition, subject to contract timing and destination restrictions. It can add trust after the delay and then make immediate authorizer withdrawals to that trusted address. It can schedule arbitrary delayed withdrawals, recover immediately to the fixed recipient, pause and resume, and schedule rotation to fresh addresses after the delay.

The immutable recovery recipient remains fixed, but it does not constrain ordinary withdrawals. The delay still applies to new trust, non-trusted withdrawal, and rotation. Existing trusted recipients and recovery to the immutable recipient remain immediate paths. No third role can veto both compromised authorities.

### Recovery recipient compromised

Compromise of the recovery recipient does not grant signing authority. It does mean every recovery transfer delivers assets into attacker control. The recovery authorizer should not use `recover` in that condition. While unpaused, the authorizer may still use an ordinary withdrawal path to another eligible recipient. Rotation cannot change the recovery recipient.

### Relayer compromised

A relayer can censor, reorder, delay, or prematurely submit signatures it possesses. It cannot change signed fields. Because deadlines are inclusive and signatures can be submitted by anyone, confidentiality of a signed payload is not an authorization control. A leaked valid signature may be used until its deadline unless its nonce or state transition has already been consumed or the epoch changes.

Relayer censorship can prevent timely pause, cancellation, or veto submission unless another sender is available. Authorities need independent transaction-submission capability and external native currency for fees.

## Epoch effects and stale authority state

Successful rotation retires both old authority addresses permanently for purposes of future rotation targets. Neither retired address may later be installed in either role. Current addresses also cannot be reused in either proposed slot, so both roles change together.

Epoch change has four important consequences:

1. Old EIP-712 signatures fail because the domain version changes.
2. Every active trust grant becomes false because `trusted` compares against the new epoch.
3. Pending trust additions from the older epoch cannot activate.
4. Scheduled withdrawals from the older epoch cannot execute.

Rotation does not explicitly delete old requests or pending trust storage. They remain observable but fail their epoch checks. Rotation also does not reset pause, trust nonces, bitmap nonces, control nonce, or rotation nonce.

## Asset and token threats

### Native currency

Native outflow uses a low-level call with empty calldata. Recipient code can revert and block that transfer. An insufficient vault balance also fails. The guarded outflow functions reject reentrant entry into any function using the same nonreentrancy modifier, but unguarded functions retain their own signature, state, and pause checks.

Native currency may be forced into the contract without invoking `receive`, so event-derived deposit totals need not equal the actual balance.

### ERC20 deposits

`depositToken` measures the balance increase and records net received. This accommodates an inbound recipient-fee token when the vault's balance rises by less than the requested amount. It rejects missing code, bad `balanceOf`, call failure, malformed optional returns, and a measured balance decrease.

A successful deposit does not certify outbound compatibility. Tokens can also be sent directly to the vault without `depositToken`, bypassing its checks and event.

### ERC20 outflows

Every ERC20 outflow requires an exact balance decrease at the vault and exact equal increase at the recipient. This excludes ordinary sender-fee and recipient-fee transfers and many rebasing or reflective designs. Positive self-transfer to the vault is rejected. Zero transfer succeeds only when both measured balances are unchanged.

The contract relies on two pre-transfer and two post-transfer `balanceOf` results plus the token call outcome. A malicious token can lie consistently, change behavior by caller or block, invoke callbacks, upgrade, denylist addresses, freeze, or consume excessive gas. Exact balance checks narrow compatibility; they do not prove token honesty or safety.

### Unsupported or potentially stranded ERC20s

The following behaviors are unsupported or not reliably supported by the code:

| Token behavior | Result or risk |
|---|---|
| Token address has no code | Deposit and outflow fail with `TransferFailed`. |
| `balanceOf` reverts or returns a length other than 32 bytes | Operation fails with `TransferFailed`. |
| `transfer` or `transferFrom` returns false, malformed data, or a noncanonical value | Operation fails with `TransferFailed`. |
| Outbound recipient fee | Recipient delta is short; outflow reverts with `ExactTransferMismatch`. |
| Outbound sender fee | Vault debit exceeds signed amount; outflow reverts with `ExactTransferMismatch`. |
| Rebase or reflection during measurement | Exact deltas may fail; behavior is not supported reliably. |
| Denylist, frozen transfer, or token pause | Outflow may remain impossible until token policy changes. |
| Upgradeable token changes semantics | A previously movable balance may become incompatible. |
| Callback-mutating or malicious accounting | The guard limits direct guarded-function reentry, but arbitrary correctness is not guaranteed. |
| Directly transferred incompatible token | It may be permanently stranded because there is no arbitrary-call or rescue bypass. |

There is no privileged function that ignores exact-transfer checks. Consequently, an incompatible token can remain permanently at the vault address even if both authorities cooperate.

## Denial of service and availability risks

Permanent loss of either key prevents rotation. If paused, it also prevents resume and all outflow. This is an explicit availability tradeoff rather than a recoverable administrative condition.

A compromised authority can pause unilaterally. Neither authority can unpause unilaterally. Either authority can repeatedly veto jointly scheduled rotations while it remains a current signer. Either authority can cancel queued withdrawals using its own namespace. A compromised recovery signer can therefore interfere with authorizer-led migration even though it cannot redirect an ordinary withdrawal.

Recipients and token contracts can cause transfer failure. Failed delayed withdrawals retain an unexecuted request and can be retried after funding or token conditions change. A failing trusted withdrawal or recovery rolls back nonce consumption, allowing an identical valid authorization to be retried before its deadline.

A newer trust schedule for the same account supersedes the old pending addition. A newer rotation schedule supersedes the old pending rotation. These replacements require the proper signatures and next sequential nonce, but operators must track the latest on-chain value rather than relying on an earlier event.

The contract has no enumeration for all token balances, trusted addresses, or requests. Complete inventory depends on external indexing and known asset lists.

## What the contract does not protect against

1. A signer approving malicious but correctly encoded data.
2. Compromise of both authority environments or a shared seed behind nominally separate addresses.
3. Loss or compromise of the immutable recovery recipient.
4. Front-end, RPC, DNS, hardware-wallet display, or supply-chain compromise that misleads signers.
5. Chain reorganization, censorship, timestamp behavior, or consensus failure outside EVM execution.
6. Incompatible, malicious, upgraded, frozen, or nonstandard token contracts.
7. Funds sent to the wrong vault or assets for which no working transfer path exists.
8. Failure to monitor the delay window or submit pause, cancellation, and veto transactions in time.
9. Economic losses after assets arrive at an authorized destination.
10. Recovery of funds from a paused vault after permanent loss of either authority key.

## Operational controls implied by the design

The two authority keys should be held in genuinely separate custody, with independent devices, backups, operators, and transaction review. The immutable recovery recipient must be verified before deployment and tested for every intended asset. Because it cannot be changed, its long-term availability is part of the custody design.

Signing software should read `chainId`, vault address, `VERSION()`, current authorities, pause state, and the relevant nonce directly from multiple trusted sources. It should display every typed-data field and allocate nonces with awareness of shared bitmap namespaces. Pre-signing long-deadline dual-authority payloads increases the useful window after one signer is compromised.

Monitoring should cover deposits, balances, trust schedules and activations, withdrawals, cancellation, pause transitions, recovery, rotation schedules, vetoes, activation, authority addresses, epoch, and unsupported token arrivals. Monitoring is especially important because scheduled operations never expire automatically after their signing deadline.

Incident procedures must distinguish loss from compromise and paused from unpaused state. In an unpaused authorizer-loss case, compatible assets can move only through recovery to the fixed recipient. In an unpaused recovery-key-loss case, the authorizer can use delayed ordinary withdrawals. In either paused single-key-loss case, there is no on-chain path to resume or withdraw without restoring the missing key.

Asset onboarding should test both inbound and exact outbound behavior using the deployed token implementation and intended recipients. A successful inbound transfer is insufficient evidence. Upgradeable or policy-controlled assets require continuing review because compatibility can change after deposit.

## Evidence and residual risk

The current tests exercise signature-domain binding, low-`s` enforcement, replay protection, inclusive deadline and timelock boundaries, pause ordering, rotation invalidation, nonce rollback, reentrancy attempts, key-loss scenarios, delayed-request retry, fee-token deposits, and rejection of non-exact outbound token behavior. Tests demonstrate expected behavior for covered implementations and simulated state transitions. They are not a proof that arbitrary tokens, signing systems, custody procedures, or deployed chain infrastructure are safe.

The largest residual risks follow directly from the code: permanent two-key dependence for resume and rotation, immutable recovery destination, immediate authority-specific paths, reliance on off-chain observation during delays, and possible permanent stranding of unsupported ERC20 balances.
