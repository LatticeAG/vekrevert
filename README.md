# VekRevert

The compensating-transactions / undo layer for agent side effects.

Reversibility is a property of the action, not the agent. VekRevert records what actually executed as a sealed, hash-chained receipt, classifies how reversible it was, and executes verified compensations in reverse order - or escalates to a human when it cannot.

## OSS core (MIT)

`@latticeag/vekrevert-core`, `@latticeag/vekrevert`, `latticeag-vekrevert` (Python), `@latticeag/vekrevert-compensators`, the `vekrevert` CLI, SQLite/JSONL ledger, four built-in compensator classes (file writes, DB row mutations, HTTP creations, sent messages), and chain verification. Fully functional standalone and self-hostable with no network dependency.

## Coordination boundary (OSS v1)

Resource leases coordinate compensations **within one ledger**. Cross-ledger coordination (two processes, two SQLite files, one shared resource) is out of scope for OSS v1 and is a named hosted feature. Two processes with two separate SQLite ledgers sharing one external resource are protected only by idempotency keys and postcondition conflict detection (`VR5006`).

## Install

```
pnpm install
pip install -e sdk-python
```

Drafted compensations are off by default (`allowDrafted: false`). A workspace may opt in with `drafted.allow` (globs such as `fs.*` / `message.*`); anything outside that list is still `VR4005`. Drafted plans always need a gate record. In `audit` a failing gate escalates instead of executing; `enforce` returns the existing `PlanRejection` shape via `recordToRejection`. The verifier gate defaults to `audit` (records verdicts, never blocks registered/builtin execute). This is not a hosted model SLA: when the model is unreachable the structural verifier decides and caps the verdict at `uncertain`. Cross-ledger coordination remains a hosted feature; OSS v1 still coordinates only within one ledger.

## License

MIT
