# VekRevert

The compensating-transactions / undo layer for agent side effects.

Reversibility is a property of the action, not the agent. VekRevert records what actually executed as a sealed, hash-chained receipt, classifies how reversible it was, and executes verified compensations in reverse order - or escalates to a human when it cannot.

## OSS core (MIT)

`@latticeag/vekrevert-core`, `@latticeag/vekrevert`, `latticeag-vekrevert` (Python), `@latticeag/vekrevert-compensators`, the `vekrevert` CLI, SQLite/JSONL ledger, four built-in compensator classes (file writes, DB row mutations, HTTP creations, sent messages), and chain verification. Fully functional standalone and self-hostable with no network dependency.

## Coordination boundary (OSS v1)

Resource leases coordinate compensations **within one ledger**. Cross-ledger coordination (two processes, two SQLite files, one shared resource) is a named hosted feature: `vekrevert coordinate` plus `coordinatorUrl`. When `coordinatorUrl` is unset, behavior is byte-identical to in-ledger leases. The coordinator is **not** a global lock manager — leases are per-resource and short-TTL. See `docs/coordination.md`. Without a coordinator, two separate SQLite ledgers sharing one external resource are protected only by idempotency keys and postcondition conflict detection (`VR5006`).

## Install

```
pnpm install
pip install -e sdk-python
```

Drafted compensations are off by default (`allowDrafted: false`). A workspace may opt in with `drafted.allow` (globs such as `fs.*` / `message.*`); anything outside that list is still `VR4005`. Drafted plans always need a gate record. In `audit` a failing gate escalates instead of executing; `enforce` returns the existing `PlanRejection` shape via `recordToRejection`. The verifier gate defaults to `audit` (records verdicts, never blocks registered/builtin execute). This is not a hosted model SLA: when the model is unreachable the structural verifier decides and caps the verdict at `uncertain`. Cross-ledger fencing is opt-in via `coordinatorUrl` / `VEKREVERT_COORDINATOR_URL` and `vekrevert coordinate`. Unset, OSS still coordinates only within one ledger. The coordinator does not lock a cluster or merge SQLite chains.

See `docs/eval.md` for measured numbers on 50 frozen Hermes-shaped traces (reversal, false-escalation, chain integrity, classify latency) plus the 200-case red-team control. Reproduce with `pnpm exec tsx bench/eval_real_traces.ts`. That eval is not a replay of the original machines: paths and contents are redacted.

## License

MIT
