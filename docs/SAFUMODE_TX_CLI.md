# SAFUMODE offline transaction CLI

This CLI separates **preparation** from **relay**. Preparation is deterministic and offline: it reads a pinned deployment manifest and action input, emits EIP-712 JSON to stdout, and has no private-key option, wallet connection, RPC call, or signing code. Sign the emitted `domain`, `types`, and `message` externally using each role listed in `expectedSigners`.

> Prototype only. Never use real keys or assets. No public-chain broadcast is implemented.

## Prepare

```sh
node scripts/safumode-cli.js prepare --manifest deployments/hardhat-local.json \
  --action schedule --input /tmp/action.json > /tmp/typed.json
```

Input fields by action:

| action | input fields | required signatures |
|---|---|---|
| `schedule` | `asset,to,amount,nonce,deadline` | authorizer |
| `withdraw` | `asset,to,amount,nonce,deadline` | authorizer |
| `recover` | `asset,amount,nonce,deadline` | recovery authorizer |
| `trust` | `account,trusted,nonce,deadline` | both when adding; authorizer when revoking |
| `cancel` | `requestId,byRecovery,nonce,deadline` | selected authority |
| `pause` | `paused,byRecovery,nonce,deadline` | selected authority to pause; both to resume |
| `rotate` | `authorizer,recoveryAuthorizer,nonce,deadline` | both current authorities |

Addresses are checksummed, integers are canonical decimal strings, action-forced fields (`immediate`) cannot be overridden, and JSON keys are recursively sorted. The domain defaults to epoch version `1:0`; after rotation pass the independently verified current version using `--version 1:N` (or pin `eip712.version` in the manifest), and refresh the manifest with an `authorities` object containing the current `authorizer` and `recoveryAuthorizer`. Relay reads both authorities on chain and rejects stale signer metadata rather than trusting constructor values after rotation. Verify every displayed field on the offline signer.

The signature file is a JSON object keyed by role, for example:

```json
{"authorizer":"0x...","recoveryAuthorizer":"0x..."}
```

## Verify / relay

```sh
# Safe default: validates and simulates policy only; does not send
npm run tx:relay -- --manifest deployments/hardhat-local.json --bundle /tmp/typed.json \
  --signatures /tmp/signatures.json --rpc http://127.0.0.1:8545

# Explicit local ephemeral-chain broadcast using an unlocked Hardhat account
npm run tx:relay -- --manifest deployments/hardhat-local.json --bundle /tmp/typed.json \
  --signatures /tmp/signatures.json --rpc http://127.0.0.1:8545 --broadcast \
  --relayer 0xUNLOCKED_ACCOUNT --relayer-index 0
```

Relay re-derives canonical typed data from the manifest/action, verifies the manifest fingerprint against the local Hardhat artifact/build-info and package lock, checks the runtime pin, RPC chain, live runtime bytecode, current on-chain authorities, on-chain version/domain separator, deadline, action-specific nonce state, every required recovered signer, and exact action shape before sending. The library requires an explicit RPC URL and is hard-limited (including direct library calls) to chain ID `31337` and a loopback hostname; public endpoints are rejected, not downgraded. Broadcast additionally requires explicit `--broadcast`, an explicit relayer address, and a strict non-negative decimal account index. The selected unlocked RPC signer must equal that address. The relay never accepts or reads a private key.

### Loopback proxy trust boundary

The hostname check establishes only that the immediate JSON-RPC endpoint is on the local machine. A loopback reverse proxy, SSH tunnel, container port-forward, or malicious local service can forward requests to a public chain or alter responses. Chain ID, bytecode, domain, authority, and nonce checks reduce mistakes but do not make such a proxy trusted. Use a dedicated local Hardhat node, inspect proxy/tunnel configuration, keep it inaccessible to other users, and never map a public RPC behind a loopback URL. This prototype must not hold real keys or assets.

`cancel` means withdrawal cancellation. Rotation activation, rotation cancellation, trust activation, and scheduled-withdrawal execution do not require EIP-712 signatures and are intentionally outside this signing CLI.

Run focused tests with `npm run test:tx`.
