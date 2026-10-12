# Authorization Vault Prototype

Local educational EVM vault prototype. **Not audited, production-ready, or deployed.**

## Security model

- Deposits are permissionless.
- The primary offline authorizer signs withdrawals. Untrusted-recipient withdrawals wait for the immutable non-zero `delay` and may be cancelled by either authority.
- A recipient cannot become trusted from a primary signature alone. `scheduleTrust` requires matching EIP-712 `SetTrusted(..., true, ...)` signatures from both the primary and independent recovery authorizers. `activateTrust` is only possible after `delay`.
- Trust changes use a strictly sequential nonce for each recipient (`trustNonce[account]`). Replays, skipped nonces, and older authorizations are rejected.
- `revokeTrust` requires the next primary-signed `SetTrusted(..., false, ...)` nonce, takes effect immediately, and deletes any pending addition. Thus a queued stale authorization cannot restore revoked trust.
- Recovery transfers can only go to the immutable recovery recipient.

There is deliberately no mutable administrator or deployment script. Initial trusted recipients are not accepted by the constructor; every addition must pass independent co-signing and delayed activation.

## Trust workflow

1. Read `trustNonce(account)` and use exactly the next nonce.
2. Both authorities sign the same EIP-712 `SetTrusted(account, true, nonce, deadline)` value.
3. Any relayer calls `scheduleTrust` with both signatures.
4. After `delay`, anyone calls `activateTrust(account, nonce)`.
5. To revoke, the primary signs `SetTrusted(account, false, nextNonce, deadline)` and a relayer calls `revokeTrust`; this is immediate.

## Local verification

```sh
npm test
```
