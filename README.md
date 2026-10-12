# SAFUMODE

A separate EVM vault for assets you do not want controlled by your everyday wallet. Anyone can fund it or relay a signed instruction. Moving assets out requires an authority signature, and the destination determines whether the transfer waits. The funding wallet has no special withdrawal rights.

This repository contains the Solidity vault, a local operator workflow, a read only browser, and a monitor. It does not contain a public deployment, a production signer, or a live alert service. The code has not had an independent security review. Do not put real assets or production keys into this build.

## Where to start

| If you want to know... | Read |
| :--- | :--- |
| What the contract actually accepts | [Protocol](docs/PROTOCOL.md) and [AuthorizationVault.sol](contracts/AuthorizationVault.sol) |
| What happens when a key is stolen or lost | [Threat model](docs/THREAT-MODEL.md) and [Key loss runbook](KEY-LOSS-RUNBOOK.md) |
| How the local operator flow works | [Operator notes](docs/OPERATOR.md) |
| What the tests exercise | [Testing](docs/TESTING.md) |
| How monitoring stores alerts | [Monitor notes](SAFUMODE.md) |
| Where the contract, scripts, and browser meet | [Architecture](docs/ARCHITECTURE.md) |
| How to report a vulnerability privately | [Security](SECURITY.md) |
| What an outside reviewer should inspect | [Review packet](AUDIT-PACKET.md) and [Audit readiness](AUDIT-READINESS.md) |

## The arrangement

The withdrawal authorizer signs ordinary exits. A trusted recipient can receive an immediate withdrawal. An address that is not trusted has to wait through the vault's configured delay, during which either authority can cancel the request.

The recovery authorizer can move assets immediately, but only to the recovery recipient fixed at deployment. The caller cannot substitute an address. Trust additions and changes to the two authorities require both signatures and a delay. Trust revocation can be done by the withdrawal authorizer alone. Either authority may pause or veto a pending authority rotation. Resuming requires both signatures. While paused, neither withdrawals nor authority rotation can go through.

That last rule has a sharp edge. If one authority is permanently lost while the vault is paused, the survivor cannot resume it or replace the missing key. This is an explicit tradeoff in the current contract, not a recovery feature. The [key loss runbook](KEY-LOSS-RUNBOOK.md) goes through the cases.

ERC20 transfers out must debit the vault and credit the recipient by exactly the signed amount. Tokens with transfer fees, rebasing, or other unusual balance behavior can become immovable. The contract can accept a token deposit based on the net amount received without establishing that the token can later leave. Do not infer asset compatibility from a successful deposit.

## What exists today

The contract and its test fixtures live in `contracts/` and `test/`. The browser in `web/` reads vault state and recent activity; it does not sign transactions. Its production deployment allowlist is empty. An unknown address or failed pin check is not shown as a verified vault. A user supplied RPC can still lie about chain state, including code and balances.

The scripts can prepare EIP 712 data offline, simulate signed calls, and relay them only through an explicitly selected local Hardhat node. The unsigned lifecycle commands can activate matured local operations. None of these scripts is a production signing or relay service. The operator drill uses disposable keys and an ephemeral chain.

The monitor reads events from a pinned contract and stores local checkpoint, spool, and journal files. The separate alert tool can record a local acknowledgement without deleting journal entries. A local acknowledgement is not evidence that someone received a page or responded to an incident. There is no managed production monitor here.

## Run it locally

Use Node and npm with the checked in lockfile.

```sh
npm ci
npm run compile
npm test
npm run operator:drill
npm run test:e2e:ui
npm run test:e2e:lifecycle
npm run build
```

The browser test requires Chrome or Chromium. If detection fails, set `CHROME_PATH` to its executable. The test harnesses start temporary Hardhat chains and use disposable development accounts. `npm run dev` serves the static browser locally. It is a read only view, not a place to connect a funded wallet or sign a vault instruction.

For a longer account of what each command proves and where the coverage stops, read [Testing](docs/TESTING.md). For local manifest generation and the transaction workflow, read [Operator notes](docs/OPERATOR.md).

## Release status

There is no endorsed mainnet or testnet deployment. This repository is private, so its GitHub URL is not public proof of the code. Tests and CI exercise local deployments; they are not an audit. Real custody would require an independent review and remediation, an asset policy, real device and key loss rehearsals, a staffed alert route, and a separate decision to deploy. The review packet is prepared, but no completed audit is claimed.
