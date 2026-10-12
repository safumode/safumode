# Operator notes

This repository provides a local rehearsal, not a production custody service. Its deployment, preparation, relay, and lifecycle code deliberately accepts only a Hardhat chain with chain ID `31337`. Relay and lifecycle RPC URLs must use `localhost`, `127.0.0.1`, or `[::1]`. The manifest verifier also rejects non-loopback RPC URLs. Do not place a public RPC behind a local proxy or tunnel: the hostname check sees only the first hop.

The browser is read only, the CLI does not hold private keys, and the monitor has no signer. These separations are useful boundaries, but they do not supply key custody, approval policy, reliable transaction submission, or incident response.

## Fast local rehearsal

Install exactly the dependency versions in the lockfile, compile, and run the self-contained drill:

```sh
cd /path/to/safumode
npm ci
npm run compile
npm run operator:drill
```

The drill uses an in-process Hardhat chain, generated in-memory authority wallets, and an unlocked Hardhat account only as the relayer. It funds a temporary vault, schedules and activates trust, pauses and resumes, performs immediate and delayed withdrawal paths, cancels a request, recovers to the fixed recipient, vetoes one rotation, and activates a later rotation. Nothing from the run is a reusable deployment or key ceremony.

## Persistent local node and deployment manifest

Use two terminals. In the first, start a node bound to loopback:

```sh
cd /path/to/safumode
npx hardhat node --hostname 127.0.0.1 --port 8545
```

In the second, compile, deploy, and verify against that same running process:

```sh
cd /path/to/safumode
npm run manifest:deploy:local
npm run manifest:verify:local
```

The deployment command writes `deployments/hardhat-local.json` unless `SAFUMODE_MANIFEST` selects another path. `SAFUMODE_LOCAL_DELAY` may set the delay in seconds. The default is `3600`.

```sh
SAFUMODE_LOCAL_DELAY=60 \
SAFUMODE_MANIFEST=deployments/rehearsal.json \
npm run manifest:deploy:local

node scripts/verify-local-manifest.js \
  deployments/rehearsal.json \
  http://127.0.0.1:8545
```

Deployment uses Hardhat accounts 1, 2, and 3 as the two authorities and fixed recovery recipient. Those published development credentials are unsafe anywhere except a disposable local chain. The manifest records the chain and contract address, runtime code hash, constructor values, deployment transaction, compiler input and settings, source hashes, bytecode hashes, package lock hash, and aggregate build fingerprint. Verification also reads immutable state and checks the creation transaction. A verified local manifest is evidence about this local run only.

Restarting `hardhat node` creates a different chain state. A manifest from the old process should fail verification and must not be carried forward.

## Prepare and relay signed actions

The accepted preparation actions are `schedule`, `withdraw`, `recover`, `trust`, `cancel`, `pause`, `rotate`, and `cancel-rotation`. Full field and signer requirements are in [SAFUMODE_TX_CLI.md](SAFUMODE_TX_CLI.md). This example prepares a delayed native withdrawal, where the zero address identifies the native asset:

```sh
cat > /tmp/safumode-action.json <<'JSON'
{
  "asset": "0x0000000000000000000000000000000000000000",
  "to": "0xREPLACE_WITH_A_VALID_RECIPIENT",
  "amount": "1000000000000000",
  "nonce": "1",
  "deadline": "REPLACE_WITH_A_FUTURE_UNIX_TIMESTAMP"
}
JSON

npm run tx:prepare -- \
  --manifest deployments/hardhat-local.json \
  --action schedule \
  --input /tmp/safumode-action.json \
  > /tmp/safumode-bundle.json
```

Replace the two marked values before running the command. Preparation reads local files only. It emits canonical EIP-712 data and the exact `expectedSigners`; it neither contacts an RPC nor signs. Review the domain, action, every message field, manifest pins, and expected signer on an independent signing interface. Put externally produced signatures in a role-keyed file such as:

```json
{
  "authorizer": "0xSIGNATURE"
}
```

Relay is a simulation unless `--broadcast` is present:

```sh
npm run tx:relay -- \
  --manifest deployments/hardhat-local.json \
  --bundle /tmp/safumode-bundle.json \
  --signatures /tmp/safumode-signatures.json \
  --rpc http://127.0.0.1:8545
```

Before simulation or broadcast, relay reconstructs the typed data, verifies signatures, local build and runtime pins, chain, current authorities, domain version and separator, deadline, and nonce state. Simulation uses `staticCall` and does not change state.

A local broadcast requires an explicit unlocked Hardhat account address and its account index:

```sh
npm run tx:relay -- \
  --manifest deployments/hardhat-local.json \
  --bundle /tmp/safumode-bundle.json \
  --signatures /tmp/safumode-signatures.json \
  --rpc http://127.0.0.1:8545 \
  --broadcast \
  --relayer 0xREPLACE_WITH_HARDHAT_ACCOUNT_0 \
  --relayer-index 0
```

The account selected by `--relayer-index` must equal `--relayer`, and its signer must come from the same provider object used for validation. The CLI has no private-key argument. After authority rotation, preparation must use the current epoch version `--version 1:N` and a manifest whose `authorities` values identify the current signers. Relay rejects stale signer metadata.

## Activate matured operations

Trust activation, scheduled withdrawal execution, and rotation activation are unsigned lifecycle calls. Each command validates the manifest and exact pending state, checks maturity, then simulates by default.

```sh
node scripts/safumode-cli.js lifecycle \
  --manifest deployments/hardhat-local.json \
  --rpc http://127.0.0.1:8545 \
  --action activate-trust \
  --account 0xREPLACE_WITH_ACCOUNT \
  --nonce 1

node scripts/safumode-cli.js lifecycle \
  --manifest deployments/hardhat-local.json \
  --rpc http://127.0.0.1:8545 \
  --action execute-withdrawal \
  --request-id 0xREPLACE_WITH_64_HEX_DIGITS

node scripts/safumode-cli.js lifecycle \
  --manifest deployments/hardhat-local.json \
  --rpc http://127.0.0.1:8545 \
  --action activate-rotation \
  --nonce 1
```

To submit one of these on the disposable node, append `--broadcast --relayer 0xREPLACE_WITH_HARDHAT_ACCOUNT_0 --relayer-index 0`. A successful dry run is not a reservation. State can change before submission, so recheck the receipt and final contract state.

## Browser and monitor

Run the read-only browser locally with:

```sh
npm run dev
```

It listens on `http://localhost:4173` by default. `PORT=4180 npm run dev` selects another port. The checked-in `web/deployment-allowlist.json` contains no endorsed deployment. The browser can read from a user-selected RPC, but that RPC controls the view of chain state. Matching an allowlist pin limits some mistakes; it does not establish RPC honesty or event completeness. Signing remains disabled.

Monitor options are authoritative in the executable help:

```sh
npm run safumode -- --help
```

A local one-shot scan against the rehearsal node has this form:

```sh
npm run safumode -- \
  --rpc http://127.0.0.1:8545 \
  --chain-id 31337 \
  --address 0xREPLACE_WITH_MANIFEST_ADDRESS \
  --code-hash 0xREPLACE_WITH_MANIFEST_RUNTIME_CODE_HASH \
  --start-block REPLACE_WITH_DEPLOYMENT_BLOCK \
  --checkpoint /tmp/safumode.checkpoint.json \
  --spool /tmp/safumode.alerts.json \
  --journal /tmp/safumode.alerts.jsonl \
  --confirmations 0 \
  --once
```

Unlike transaction tools, the monitor permits HTTP or HTTPS RPCs on other hosts. That is not an endorsement of a production setup. It requires a trusted archival RPC with complete blocks, receipts, and logs. It checks queried logs against receipts and retains local reorg history, but a single malicious provider can present a self-consistent false chain.

Inspect and acknowledge the local journal with the exact chain and checksummed vault address:

```sh
npm run safumode:alerts -- inspect \
  --journal /tmp/safumode.alerts.jsonl \
  --chain-id 31337 \
  --address 0xREPLACE_WITH_CHECKSUMMED_MANIFEST_ADDRESS

npm run safumode:alerts -- acknowledge \
  --journal /tmp/safumode.alerts.jsonl \
  --chain-id 31337 \
  --address 0xREPLACE_WITH_CHECKSUMMED_MANIFEST_ADDRESS \
  --id 'REPLACE_WITH_ALERT_ID'
```

Acknowledgement writes a separate sidecar and does not alter the journal. It records a local operator action only. Neither stdout acceptance, journal persistence, nor acknowledgement proves delivery to a pager, human review, or remediation. File durability, lock recovery, replay, reorg behavior, and storage limits are described in [SAFUMODE.md](../SAFUMODE.md).

## Trust boundary and unsupported production work

The local tools trust the checked-out source, lockfile, compiler artifacts, host filesystem, local process table, and selected Hardhat RPC. They do not establish that a workstation is uncompromised. The relayer sees signed authorization material and can choose when to submit it within its deadline, although it cannot change signed fields. Anyone able to control the RPC can misreport simulation and state. Authority devices must independently verify typed data rather than trust CLI output alone.

There is no production deployment procedure, hardware-wallet integration, signer quorum service, secret storage, supported-token registry, public-chain relayer, managed monitor, downstream alert transport, on-call policy, backup restoration exercise, or audited release in this repository. Public-chain deployment and relay are intentionally blocked in the transaction workflow. The monitor's remote-RPC path exists, but no test here validates a real provider, sustained catch-up load, service supervision, disk exhaustion response, pager delivery, or human incident handling. ERC20 behavior has only been tested with included fixtures; a successful deposit does not prove that a particular deployed token can be withdrawn.

Use [TESTING.md](TESTING.md) to distinguish exercised behavior from these operational gaps.
