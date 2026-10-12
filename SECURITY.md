# Security

SAFUMODE is an unaudited local prototype. There is no endorsed public vault address and no supported real funds deployment. The tests are useful for finding regressions, not a certificate that the contract or operator workflow is safe.

## Reporting an issue

Please do not open a public issue with an exploit, private key, seed phrase, or funded address. If GitHub's private vulnerability reporting is available for this repository, use its Security tab. Otherwise contact the repository owner through an existing private channel and ask for a secure reporting route before sharing details. No bug bounty or response deadline is offered here.

A useful report names the affected commit, the call sequence, what an attacker controls, and the state or assets at risk. A small local reproduction on a disposable Hardhat chain is preferable to testing against someone else's vault.

## Boundaries to review

The withdrawal and recovery authorities are distinct EIP 712 signers. Depositors and transaction relayers are not privileged. Both authorities are needed to add trust, resume after a pause, or rotate the keys. Either authority can pause, and either can veto a pending rotation. Recovery can send assets immediately to the fixed recipient; compromise of that signer and recipient is a concentrated risk. A lost authority cannot be replaced by the survivor under the current design.

The browser has no signing flow and the production deployment allowlist is empty. A user supplied RPC can lie even when it supplies internally consistent responses. The monitor is read only and relies on its RPC, local disk, and a separate operator to deliver and act on alerts. An alert recorded in its journal is not proof that a person saw it.

ERC20 deposits can accept a net received amount, while ERC20 withdrawals require exact vault debit and recipient credit. Fee tokens and other nonstandard balances may become stuck. Nobody should treat this repository as an unrestricted ERC20 vault.

The complete authority and failure cases are in [the threat model](docs/THREAT-MODEL.md). The function and signature rules are in [the protocol description](docs/PROTOCOL.md). The [review packet](AUDIT-PACKET.md) identifies the files and questions for an independent review.
