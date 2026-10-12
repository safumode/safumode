# Ledger signing (local Hardhat vault only)

The CLI can ask a USB-connected Ledger Ethereum app to **clear-sign** an EIP-712 authorization. It does not use private keys from disk, and it never falls back to blind hash signing. The device address must equal the authority address in the pinned local deployment manifest. This command does not connect the public SAFUMODE website or enable mainnet deposits/withdrawals.

1. Unlock Ledger, open the Ethereum app, connect via USB, and close Ledger Live or other apps holding the USB device.
2. Prepare a bundle with `node scripts/safumode-cli.js prepare --manifest local-manifest.json --action recover --input recover.json > bundle.json` (use the appropriate action and input).
3. Review the domain, action, destination, amount, deadline and signer in `bundle.json`. Sign: `node scripts/safumode-cli.js sign-ledger --manifest local-manifest.json --bundle bundle.json --role recoveryAuthorizer > ledger-result.json`. The default path is `44'/60'/0'/0/0`; specify `--path` if the configured Ledger authority uses a different Ethereum account.
4. After verifying the output, extract its `signature` into a signatures file keyed by role, e.g. `{ "recoveryAuthorizer": "0x..." }`. For two-key operations, sign each role separately, with separate devices/accounts, and include both signatures.
5. Dry-run via `node scripts/safumode-cli.js relay --manifest local-manifest.json --bundle bundle.json --signatures signatures.json --rpc http://127.0.0.1:8545`. Local broadcast remains an explicit separate opt-in.

A physical Ledger has **not** been connected or tested in this development environment. A device/app that does not support clear EIP-712 signing will fail closed. Do not enable blind signing as a workaround. Mainnet is deliberately blocked by the manifest, chain and relay guards until a separately audited production signing/release flow exists.
