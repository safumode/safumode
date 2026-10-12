# SAFUMODE read-only monitor

`SAFUMODE` is an independent, provider-only monitor for `AuthorizationVault`. It has no signer, accepts no private-key option, never invokes `eth_sendTransaction`, and cannot automatically change vault state. Run it separately from relayers and the web UI.

It alerts (one JSON object per stdout line) for withdrawal scheduling/execution/cancellation, trust scheduling/change, pause changes, authority rotation scheduling/execution/cancellation, and recovery execution. Operational failures are JSONL on stderr and exit non-zero. RPC URLs are never included in output.

## Trust boundary and limitations

**A trusted archival RPC is required.** It must return complete historical blocks, transaction receipts, and logs. No client can prove completeness when its only information source is an arbitrary malicious RPC: a provider can consistently fabricate a chain and all corresponding answers. Independently pin the chain ID, checksummed vault address, deployment block, and runtime bytecode hash, and use independently operated providers if compromise resistance is required. SAFUMODE fails closed on inconsistencies it can detect; this is monitoring, not prevention or a cryptographic completeness guarantee.

For every scanned block, the monitor fetches its header before and after the log query, obtains every transaction receipt, derives the monitored vault events from those receipts, compares that set with `eth_getLogs`, and checks every log/receipt block hash against the header before advancing its checkpoint. A missing receipt, omitted/extra log, hash mismatch, or header change stops the monitor without checkpointing that block.

## Pin the deployment

```sh
npm run safumode -- \
  --rpc https://YOUR_TRUSTED_ARCHIVAL_RPC \
  --chain-id 56 \
  --address 0xCHECKSUMMED_VAULT \
  --code-hash 0xEXPECTED_64_HEX_RUNTIME_CODE_HASH \
  --start-block DEPLOYMENT_BLOCK \
  --checkpoint /var/lib/safumode/vault.checkpoint.json \
  --confirmations 12 --poll-ms 5000 --batch-size 500 --reorg-depth 128
```

Use `npm run safumode -- --help` for options. `--once` performs one catch-up scan. On first use, omitting `--start-block` anchors the current head and starts after it (no historical alerts). A start block beyond `head + 1`, a checkpoint beyond `head + 1`, malformed/non-monotonic checkpoint history, or an unavailable startup anchor is rejected.

## Delivery, restart, and reorg behavior

* Standard output is the delivery boundary. Each JSONL alert write must complete successfully before that block is checkpointed; pipe backpressure and write errors are honored. This provides **at-least-once process-to-pipe delivery**, not durable end-to-end delivery. A crash after writing an alert but before checkpoint rename can repeat it. A downstream consumer can also lose an already acknowledged line.
* For durable operations, pipe stdout into a separate durable spool/journal that acknowledges writes only after durable storage. Deduplicate by `(blockHash, transactionHash, logIndex)`. Do not treat a terminal display or an unpersisted network pipe as a durable sink.
* Checkpoints are mode `0600`, fsynced, and atomically renamed. They retain `--reorg-depth` hashes. A mismatch emits critical `rpc_reorg`, rewinds to the newest retained common ancestor, and rescans. Replacement-chain alerts may intentionally repeat a logical action.
* Startup and each poll verify chain ID and the pinned runtime code hash. Keep the checkpoint on reliable local storage and alert on process exit/stderr.
* SIGINT/SIGTERM stop polling cleanly after the current awaited RPC/write operation. No new block is started after shutdown is observed.

## Verification

`npm run test:safumode` uses an ephemeral Hardhat chain. In addition to normal alert/restart and chain mismatch coverage, deterministic fault providers test omitted logs, a header/log reorg race, output failure, retry-after-restart, and invalid future startup/checkpoint state.
