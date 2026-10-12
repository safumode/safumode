# AuthorizationVault key-loss runbook

## Status and hard limit

This runbook describes the **chosen provisional architecture**, not an audited production recovery system. `AuthorizationVault` has two distinct signing roles:

- **authorizer**: authorizes ordinary withdrawals and trust changes;
- **recovery authorizer**: authorizes break-glass transfers to the immutable `recoveryRecipient` and can cancel queued withdrawals.

Authority rotation is delayed and requires valid signatures from **both current keys**. Either key can pause, but unpausing requires both. There is intentionally no administrator, upgrade, social recovery, or single-key rotation bypass.

**If the vault is paused and either signing key is permanently lost, the vault cannot be resumed and its assets cannot be withdrawn through the contract.** Do not imply that rotation repairs this condition: rotation itself needs both current keys.

## First response to suspected loss

1. Stop automation and relayers that submit vault operations.
2. Determine which key is unavailable and whether the vault is paused. Verify on-chain `authorizer()`, `recoveryAuthorizer()`, `recoveryRecipient()`, `paused()`, pending withdrawals, and balances using more than one RPC/provider.
3. Treat a merely unavailable key as potentially compromised. Do not expose the surviving key to an internet-connected machine in an attempt to reconstruct or rotate the missing key.
4. Preserve transaction hashes, relevant typed-data payloads, signer-device logs, and the time of discovery.
5. Follow the matching case below. Rehearse the exact transactions against a fork/local deployment before signing anything on a live network.

## Key-loss matrix

| State | Lost key | What remains possible | What is impossible | Action |
|---|---|---|---|---|
| Unpaused | Authorizer | Recovery authorizer may use `recover` for native currency and ERC20s. Every successful recovery is sent by the contract to the immutable `recoveryRecipient`. | Ordinary authorizer withdrawals, trust additions, unilaterally choosing another recovery destination, and authority rotation. | Verify the immutable recipient is controlled and safe, then recover each asset to it. Deploy a fresh vault and migrate onward from the recipient. |
| Unpaused | Recovery authorizer | Authorizer may schedule delayed native/ERC20 withdrawals to the immutable recovery recipient **or any other nonzero untrusted address**, then execute after the delay. | Break-glass `recover`, recovery cancellation, two-key trust additions, and authority rotation. | Queue transfers to a pre-verified destination, monitor for the full delay, execute, then deploy a fresh vault. |
| Paused | Authorizer | The surviving recovery key can provide one of the signatures needed for resume/rotation, but that is insufficient. Deposits may still arrive. | All withdrawal/recovery outflows; two-key resume; two-key rotation. | Do not send more assets. Escalate as an unrecoverable-on-chain custody incident unless the missing key is restored from an approved backup. |
| Paused | Recovery authorizer | The surviving authorizer can provide one of the signatures needed for resume/rotation, but that is insufficient. Deposits may still arrive. | All withdrawal/recovery outflows; two-key resume; two-key rotation. | Do not send more assets. Escalate as an unrecoverable-on-chain custody incident unless the missing key is restored from an approved backup. |

### Recipient restriction in the authorizer-loss case

`recover(asset, amount, nonce, deadline, signature)` contains no destination argument. The destination is the constructor-set, immutable `recoveryRecipient`. A `Withdraw` signature that names another address is a different EIP-712 type and cannot authorize `recover`. Before using recovery:

1. Read `recoveryRecipient()` directly from the deployed contract.
2. Independently verify control of that address and its ability to receive/manage every asset involved.
3. Inventory native currency and token contract addresses; beware unsupported, rebasing, fee-on-transfer, denylisted, or malicious tokens.
4. Generate fresh nonces/deadlines, inspect typed data on the recovery signing device, and submit a small canary where operationally appropriate.
5. Confirm receipt, then recover remaining balances asset by asset.

### Timed withdrawal in the recovery-loss case

The surviving authorizer does not gain recovery authority. It can only use normal withdrawal rules. For each asset:

1. Verify the destination byte-for-byte. It may be `recoveryRecipient` or another nonzero address, provided that address is not currently trusted (trusted destinations use a separate immediate path).
2. Sign and submit `scheduleWithdrawal` with `immediate: false`; record the returned request ID and execution time.
3. Monitor the request and source/destination addresses throughout the delay. With the recovery key missing, its cancellation power is unavailable, though the authorizer can cancel its own queued request.
4. After the delay, call `executeWithdrawal(requestId)` and verify balances/events.
5. Repeat for native currency and each ERC20. Do not mistake a successful schedule for completed migration.

## No single-key rotation or bypass

Do not try to place one signature in both rotation signature slots, label one signer as the other role, use a `Withdraw` signature as a `Recover` signature, or use a `Recover` signature as a withdrawal signature. EIP-712 role/type verification rejects these substitutions. Rotation remains 2-of-2 even during key loss and remains delayed after a valid 2-of-2 schedule.

Likewise, unilateral pause is a stop mechanism, not a recovery mechanism. Once paused, `recover`, scheduling, execution, trusted withdrawals, and trust activation are blocked. Resume requires current authorizer and recovery-authorizer signatures over the same next control nonce.

## Migration—not rotation—after a loss

After evacuating an **unpaused** vault, migrate by deploying a **fresh vault**, not by presenting key rotation as a key-loss remedy:

1. Create new role keys under the custody controls below and a verified recovery recipient.
2. Deploy a new vault with those addresses and an explicitly reviewed delay.
3. Independently verify bytecode, constructor parameters, chain ID, domain/version, and explorer/source metadata.
4. Run a complete signer rehearsal: deposits, delayed native/ERC20 withdrawals, recovery to the fixed recipient, cancellation, unilateral pause, two-key resume, and two-key delayed rotation on a local network or fork with throwaway assets.
5. Transfer only a canary amount; exercise the intended path; then migrate the remaining assets.
6. Retire old operational configuration and monitoring only after confirming the old vault balance and all token balances are zero (or documenting assets that cannot be moved).

A fresh deployment does not rescue funds from a paused vault with one missing key. It only supplies a safe destination for assets that can still be moved.

## Preventive custody and drills

Before funding any deployment:

- Keep authorizer and recovery-authorizer keys in separate hardware-backed custody, with independent operators, devices, credentials, and physical locations. Do not derive both roles from one seed or store both backups together.
- Maintain encrypted, geographically separated, tamper-evident backups according to an approved access and destruction policy. Test restoration with throwaway accounts; never type production seed material into a rehearsal environment.
- Make the immutable recovery recipient durable and independently controlled. Confirm its smart-contract/wallet behavior for native currency and all supported tokens before deployment.
- Document signer succession, quorum/contact procedures, nonce/deadline construction, chain/domain verification, and who may relay transactions. Relayers do not need signing keys.
- Monitor pause state, scheduled withdrawals, rotations, signer addresses, recovery events, deposits, and native/ERC20 balances. Alert on unexpected deposits to a permanently stuck vault.
- Rehearse loss of each key in both paused and unpaused states. The rehearsal must demonstrate the failure cases, not only successful withdrawals.
- Keep a verified asset inventory and enough native currency outside the vault to pay transaction fees.

## Launch gate

**Do not launch on mainnet before both (1) an independent security audit and remediation of its findings and (2) a real-signer operational rehearsal using the intended hardware, people, runbooks, monitoring, and relayer flow.** A passing local test is evidence about specified contract behavior, not proof of production safety.

The deterministic local matrix is `test/AuthorizationVault.key-loss.js`. It uses publicly visible throwaway development keys and must never be adapted to store production secrets.
