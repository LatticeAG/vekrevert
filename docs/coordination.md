# Cross-ledger coordinator protocol

Status: C1 designed, C2/C3 implemented (`vekrevert coordinate`, `coordinatorUrl`).
When `coordinatorUrl` is unset, lease behavior is byte-identical to OSS v1.

OSS v1 coordinates compensations **within one ledger**. Two processes with
two SQLite files that share one external resource are protected only by
idempotency keys and postcondition conflict detection (`VR5006`). This
protocol is the hosted feature named in the README. It does not change
that OSS boundary.

## 1. Problem

A resource lease in `memory` / `jsonl` / `sqlite` is process-private. Process
A's `leases` table cannot see process B's. If both undo the same HTTP
object, SQL row, or filesystem path, both may apply. Idempotency keys
dedupe **within one ledger**. `VR5006` (`concurrent_modification`) fires
**after** a mutate when a postcondition already sees a foreign write (SQL
`expect_rowcount` miss with 0 rows is the shipped case). Neither prevents
the second mutate from starting.

Postgres and the Phase 9 HTTP ledger client already treat leases as
shared (`isSharedLeaseLedger`). There is no HTTP ledger **server**. The
coordinator is that server: one lease authority both SQLite processes
call, plus a conflict log that turns a late `VR5006` into a winner/loser
verdict so the loser escalates instead of retrying.

## 2. What this is not

The coordinator is **not** a global lock manager. It does not lock a
cluster, a database, a filesystem, or a saga. A lease is one
`resource_key`, short-TTL, stolen when the TTL elapses. It does not:

- Merge, replicate, or hash-chain two SQLite ledgers together. Each
  local chain stays local. Coordinator event storage is a Phase 9 hosted
  ledger, not a union of client ledgers.
- Run a distributed transaction or 2PC across ledgers or across the
  external resource.
- Order sagas. Fence numbers are per `resource_key`, not a global clock.
- Protect writers that never call it (humans, other agents, `curl`).
  `VR5006` against the world still escalates.
- Replace local idempotency keys (`AttemptRecord.idempotency_key`) or
  local attempt rows.
- Issue infinite or namespace-wide leases. `ttlMs` is required in
  spirit even when defaulted; a prefix such as `sql:postgres:app:` is
  not a lockable key unless some receipt actually emitted it.
- Provide HA, Raft, or multi-coordinator consensus. One process, one
  SQLite file.
- Bill, authenticate tenants beyond a shared bearer, or multiplex
  workspaces.

If you need a lock on “the whole world,” this is the wrong protocol.

## 3. Roles

| Role | Holds | Talks to coordinator for |
|---|---|---|
| Local ledger (sqlite/jsonl/memory) | That process's receipts, attempts, plans | Nothing, unless `coordinatorUrl` is set |
| Coordinator | Per-key leases, apply claims, optional hosted events | — |
| Client A / Client B | Two processes, two local ledgers, one shared external resource | Leases + conflicts; optionally events |

Two deployment shapes share the same wire:

1. **Fence-only.** Each process keeps its own SQLite ledger. `VekRevert`
   is constructed with a local `ledger` plus `coordinatorUrl`. Lease
   RPCs and `POST /conflicts` go to the coordinator. Receipts stay
   local and gain an additive `fencing_token`.
2. **Hosted ledger.** `openHttpLedger(coordinatorUrl)` is the ledger.
   Events, leases, and conflicts all hit the same origin. This is the
   Phase 9 client against a real server.

The coordinator MUST speak the Phase 9 HTTP ledger so (2) works without
a second client. Shape (1) uses a subset: `/health`, `/leases`,
`/conflicts`. `/events` MAY be unused by fence-only clients.

## 4. Resource key identity

Lease identity is the receipt's `resource_keys[]` string, byte-for-byte.
Keys are produced by `resourceKeys()` in `@latticeag/vekrevert-core`
(Python: `latticeag_vekrevert.core.resource_keys`). The coordinator
does not parse or rewrite them.

| Kind | Form | Example |
|---|---|---|
| HTTP | `http:{host}:{path}` | `http:api.example.com:/v1/invoices/inv_1` |
| SQL | `sql:{dialect}:{db}:{table}` or `sql:{dialect}:{db}:{table}:{k=v,...}` | `sql:postgres:app:invoices:id=7` |
| FS | `fs:{realpath}` | `fs:/var/data/config.yaml` |
| MCP | `mcp:{server}:{tool}:{primary}` | `mcp:slack:chat.postMessage:ts=123` |

Rules the coordinator relies on and does not re-implement:

- HTTP host is lowercased; default ports stripped; path `.` / `..`
  resolved; query params sorted. Hash is dropped.
- SQL PK pairs are sorted by key. Missing PK leases the table, not a
  row — callers that omit PK serialize the whole table. That is a
  client bug, not a coordinator feature.
- FS uses the realpath captured on the receipt. Two processes that
  disagree on realpath (symlink, chroot, different mounts) take
  different leases and will collide in the world, not in the
  coordinator.
- Multi-key plans acquire in **sorted** order (`sortedResourceKeys`)
  and release in reverse. The coordinator is per-key and does not
  deadlock-detect; sorted acquire is the client's job
  (`engine/lease.ts`).

A key that never appears on a sealed receipt is still leasable. The
coordinator does not check provenance. Garbage keys are just empty
slots.

## 5. Holder identity

```
holder = `{processId}:{sagaId}:{attemptId}`
```

`leaseHolder(processId, sagaId, attemptId)` in `engine/lease.ts`.
`executePlan` uses `{pid}:{saga_id}:{runId}` when the caller does not
pass `holder`. The coordinator treats `holder` as an opaque string.
Same-holder re-acquire is allowed (and bumps the fence). Different
holder against a live lease is `VR5005`.

## 6. Fencing tokens

A fence is a per-`resource_key` positive integer. It is the only
ordering the coordinator provides.

Monotonicity (matches in-process `createMemoryLedger.acquireLease` and
the Phase 9 mock in `tests/ledger_http.test.ts`):

- First successful `acquire` on a key: `fence = 1`.
- Every subsequent successful `acquire`, including steal of an expired
  lease and same-holder re-acquire: `fence = previous.fence + 1`.
- `renew` does **not** increment the fence. It only extends
  `expires_at`.
- `release` deletes the row. The next `acquire` still increments from
  the last fence the coordinator remembers for that key (see §6.1).
- `fence` never goes to 0, never wraps in this protocol, and is never
  reused for a later holder of the same key.

A holder that observes `current.fence !== held.fence` is **fenced**
(`VR5010`). `inspectFence` in `engine/lease.ts` already classifies
`ok | fenced | expired | held_elsewhere | missing`; the coordinator
does not expose that enum on the wire. Clients map HTTP status to
`VekRevertError` as today.

### 6.1 Fence high-water after release

If release deleted the row and the next acquire reset to `1`, a delayed
packet from the old holder could look current. The coordinator MUST
keep a high-water `fence` per `resource_key` after release and after
TTL expiry. `get` on a key with no live holder returns `lease: null`
but acquire still uses `high_water + 1`.

The Phase 9 mock currently resets to `1` after delete because it
stores fence only on the live row. C2 must not copy that bug. The
client already accepts any finite `fence >= 1`.

### 6.2 What a fence authorizes

A fence authorizes mutate of **that resource** until the lease expires
or a higher fence is issued. It does not authorize other keys, other
sagas, or retry after `VR5010`. Stale holders MUST NOT mutate. If they
do, the world-level postcondition and `POST /conflicts` are the backstop
(§9–10), not a promise that the coordinator can recall the write.

## 7. TTL and crash expiry

Defaults from `DEFAULT_LEASE` (`packages/core/src/types.ts`):

| Knob | Default | Owner |
|---|---|---|
| `ttlMs` | 30_000 | Client sends on acquire/renew; coordinator clamps |
| `heartbeatMs` | 10_000 | Client-only; `renew` on that interval |
| `waitMs` | 5_000 | Client-only poll budget on `VR5005` |

Coordinator clamp: `ttlMs` in `[1, 300_000]`. Omitted `ttlMs` → 30_000.
The protocol's production floor is 1_000 ms; C2 clamps down to 1 ms so
crash-injection tests can steal after a sub-second TTL. Values are
clamped, not rejected — a 400 here would map through the HTTP client to
`VR5005` and look like contention. Production clients should still send
`>= 1_000`.

Clock: coordinator wall clock is authoritative for `expires_at`.
Timestamps are ISO-8601 UTC with milliseconds (`Date.toISOString()`).
Comparison is lexicographic on that form, same as the memory ledger
(`expires_at > nowIso`).

Crash: a dead holder does not release. The waiter polls `acquire` until
`waitMs` or until `expires_at <= now`. Steal issues `fence+1` to the
new holder. The dead holder's later `renew` / `release` / fence assert
returns `412 VR5010`. That is the recovery path C3's crash-injection
test must hit: dead holder's lease expires, waiter proceeds after TTL.

There is no session, no grace period, no “still mutating” bit on the
lease itself. Apply claims (§9) exist so a steal after a **committed**
apply does not double-apply. A steal after a **claimed but uncommitted**
apply is in-doubt for the new holder: they must not mutate until
`POST /conflicts` says so.

Heartbeat failure is identical to crash. `heartbeatAll` swallowing
renew errors today is a client concern; a missed renew that crosses
`expires_at` loses the lease.

## 8. HTTP API

Base URL is the client-supplied origin, including any prefix. The Phase
9 mock serves at `http://127.0.0.1:{port}/v1`. The client does
`joinLedgerUrl(base, "/leases")` etc. The coordinator SHOULD serve
under `/v1`. Paths below are relative to that base.

All JSON request bodies are canonicalized
(`canonicalize` from core). Responses are `application/json`.

Auth: optional `Authorization: Bearer {VEKREVERT_API_KEY}`. If the
process was started with a key, missing/wrong bearer is `401`
`{error:"unauthorized"}`. If started without a key, the coordinator is
open on the bind address. That is a deployment choice, not a protocol
feature.

### 8.1 `GET /health`

Request: empty.

`200`

```json
{ "v": "vekrevert/v1" }
```

C2 MAY add `role: "coordinator"` later. Clients MUST tolerate unknown
fields. This is liveness, not readiness of the lease table.

### 8.2 `POST /events` / `GET /events`

Phase 9 hosted ledger. Fence-only clients do not have to call these.

`POST /events` body: one `ReceiptEvent`. Chain is computed
**client-side**. Server MUST echo `{hash}` equal to the body hash or
the client throws `VR2015`. Server MUST NOT invent hashes.

`GET /events` and `GET /events?saga_id=` return `{events: ReceiptEvent[]}`
(array at top-level is also accepted by the client). Returned chains
must verify with `verifyChain` + `clientChain`. Tamper → client
`VR2015`.

Coordinator event storage is the hosted ledger for shape (2). It is
not a projection of local SQLite files in shape (1).

`POST /attempts` and `PUT /compensators/:id` exist on the Phase 9
client. `404` is tolerated. The coordinator MAY omit them.

### 8.3 `POST /leases`

Body:

```json
{
  "op": "acquire" | "renew" | "release" | "get",
  "resource_key": "http:api.example.com:/v1/invoices/inv_1",
  "holder": "4127:sag_abc:att_01h...",
  "fence": 3,
  "ttlMs": 30000
}
```

| Field | acquire | renew | release | get |
|---|---|---|---|---|
| `resource_key` | required | required | required | required |
| `holder` | required | required | required | ignored |
| `fence` | ignored | required | required | ignored |
| `ttlMs` | optional | optional | ignored | ignored |

Semantics, aligned with `Ledger.acquireLease` / `renewLease` /
`releaseLease` / `getLease` and `openHttpLedger.leaseRpc`:

**acquire**

- Live lease (`expires_at > now`), different `holder` → `409`
  `{error_code:"VR5005"}`. Client throws `VR5005` `lease_unavailable`.
- Live lease, same `holder` → success, `fence = old+1`, new
  `expires_at`, `acquired_at = now`.
- Missing or expired lease → success, `fence = high_water+1` (or `1`
  if never seen), new row.
- `200` `{fence: number, expires_at: string}`. Missing either field →
  client `VR5005`.

**renew**

- No row, or `holder`/`fence` mismatch (including expired row still
  present with a different fence) → `412` `{error_code:"VR5010"}`.
- Match → `expires_at = now + ttlMs`, fence unchanged.
- `200` `{expires_at: string}`.

**release**

- No row → `200` `{}` (idempotent missing).
- Row present, `holder` or `fence` mismatch → `412`
  `{error_code:"VR5010"}`.
- Match → delete live row, keep high-water, `200` `{}`.

**get**

- `200` `{lease: LeaseRecord | null}`.
- `LeaseRecord`: `{resource_key, holder, acquired_at, expires_at, fence}`.
- Client treats `VR5005` on get as “no lease” (`getLease` returns
  `undefined`). Do not 409 a get.

Expired rows MAY be deleted lazily on the next mutate op. `get` MAY
still return an expired record; clients compare `expires_at` to now
(`inspectFence` → `expired`).

Unreachable coordinator on any lease RPC: client throws `VR5005`
`hosted lease unreachable`. Fail closed. Do not fall back to the local
sqlite `leases` table when `coordinatorUrl` is set — that would
re-create the two-ledger hole this protocol exists to close.

### 8.4 `POST /conflicts`

Not on the Phase 9 mock. C2 adds it. The lease client does not call
it; execution does.

Request:

```json
{
  "resource_key": "sql:postgres:app:invoices:id=7",
  "holder": "4127:sag_abc:att_01h...",
  "fence": 3,
  "saga_id": "sag_abc",
  "plan_hash": "sha256:…",
  "error_code": "VR5006"
}
```

`error_code` is optional. Omitted = this holder is **claiming** the
apply (intent or commit). `"VR5006"` = this holder hit concurrent
modification on the resource and wants a verdict instead of retrying.

`200`

```json
{
  "verdict": "winner" | "loser" | "in_doubt",
  "resource_key": "sql:postgres:app:invoices:id=7",
  "winner": {
    "holder": "4127:sag_abc:att_01h...",
    "fence": 3,
    "saga_id": "sag_abc",
    "plan_hash": "sha256:…",
    "state": "claimed" | "committed"
  },
  "loser": {
    "holder": "8810:sag_def:att_01h...",
    "fence": 2,
    "saga_id": "sag_def",
    "plan_hash": "sha256:…"
  }
}
```

`loser` is omitted when `verdict` is `winner` and no prior claimant
exists. `winner` is omitted when `verdict` is `in_doubt` and nobody
committed. Clients MUST treat unknown `verdict` values as `in_doubt`.

Lease errors on this endpoint use the same codes: `409 VR5005` if the
caller does not hold a live lease and is not reporting `VR5006` against
a committed claim; `412 VR5010` if `fence` is stale relative to the
live lease **and** the body is a claim (omitted `error_code`). A
`VR5006` report from a fenced holder is accepted: that is the loser
asking who won.

## 9. Conflict detection (VR5006 extended)

Today `VR5006` is local and after-the-fact: the SQL compensator throws
when `changes === 0` and `expect_rowcount.min >= 1` (the row was
already updated by someone else). HTTP 404-as-compensated is **not**
`VR5006`; it is success. Filesystem hash mismatch is `VR5002`
(postcondition). The coordinator does not redefine those.

What it adds: once any VekRevert client has **committed** an apply
claim for `resource_key`, a second client that observes `VR5006` (or
that tries to claim) gets an explicit loser verdict naming the winner's
`saga_id`, `plan_hash`, and `fence`. The loser:

1. Does not retry the mutate.
2. Does not treat the step as success.
3. Raises `escalation_raised` with `reason_code: "lease_unavailable"`
   when the loss was a live lease (`VR5005` path), or records
   `compensation_failed` with `error_code: "VR5006"` and escalates
   `compensation_failed` when the loss was a world-level concurrent
   modification. C3 must not double-apply in either case.

Apply-claim state machine per `resource_key` (at most one committed
winner; claimed is exclusive with a different live claim):

```
(none) --claim--> claimed --commit--> committed
                    |                    ^
                    +--VR5006 (self)--> in_doubt (no winner; escalate)
committed --claim(other)--> loser (winner stays committed)
committed --VR5006(other)--> loser
claimed(A) --claim(B, higher fence after steal)-->
    if A never committed: B becomes claimed, A is fenced
    (A's later commit is VR5010 / loser)
```

Claim rules:

1. **Claim (no `error_code`).** Caller MUST hold a live lease with
   matching `holder`+`fence`. If a **committed** apply exists for this
   key and `{holder,fence}` is not that winner, verdict `loser`. If a
   **claimed** apply exists for a lower fence whose lease is expired,
   the new holder may take `claimed` (handoff, §10). If `{holder,fence}`
   retries, verdict `winner` and state is unchanged (idempotent claim).
2. **Commit.** Same body as claim, sent again after a successful
   mutate, with the same `fence`. The coordinator distinguishes commit
   from intent by a second field the request MAY include:
   `"phase": "intent" | "commit"`. Omitted `phase` on a first call is
   `intent`; omitted `phase` when `{holder,fence}` is already `claimed`
   is `commit`. Clients SHOULD send `phase` explicitly.
3. **`error_code: "VR5006"`.** If a committed winner exists, return it
   and `verdict: "loser"`. If the caller still holds the lease and
   nobody committed, the writer was outside this protocol:
   `verdict: "in_doubt"`, no `winner`. Caller escalates. The
   coordinator does not invent a VekRevert winner for an uncoordinated
   write.

The conflict log is append-only for forensics. Verdicts are computed
from the current apply row plus that log, not from hosted `/events`
(those may be empty in fence-only mode).

## 10. Exactly-once handoff (two SQLite ledgers, one resource)

Setting: process A ledger file `a.sqlite`, process B ledger file
`b.sqlite`, both configured with the same `coordinatorUrl`, both about
to compensate the same `resource_key`.

This is not exactly-once delivery of receipts. Each ledger will have
its own events. It is exactly-once **mutate of the external resource**
among clients that obey this protocol.

### 10.1 Happy path (A wins the lease)

```
A: POST /leases {op:acquire, resource_key, holder:A, ttlMs}
   ← 200 {fence:1, expires_at}
B: POST /leases {op:acquire, resource_key, holder:B, ttlMs}
   ← 409 {error_code:VR5005}
B: waitMs budget; still 409 → VR5005 → escalate lease_unavailable.
   B does not mutate.
A: POST /conflicts {phase:intent, fence:1, saga_id, plan_hash}
   ← winner, state claimed
A: mutate world
A: local appendAttempt / compensation_executed with fencing_token: 1
A: POST /conflicts {phase:commit, fence:1, …}
   ← winner, state committed
A: POST /leases {op:release, holder:A, fence:1}
```

B never applied. A's local receipt chain records the token. B's local
chain records the escalation. Coordinator has one committed claim.

### 10.2 Concurrent start, B loses after A commits

B acquired nothing. B may still run a compensation if it never called
acquire (bug, or `skipAcquire`). If B mutates and hits `VR5006`:

```
B: POST /conflicts {error_code:VR5006, holder:B, fence:B.fence or 0,
                    saga_id, plan_hash}
   ← loser, winner = A's committed claim
B: escalate, do not retry
```

If B never saw `VR5006` because the compensator treated the write as
success (e.g. HTTP DELETE 404 = compensated), B MUST still `phase:intent`
before mutate when `coordinatorUrl` is set. A committed claim makes
that intent a `loser` **before** the second DELETE. That is the
difference from OSS v1, where 404-as-compensated can look like two
successes.

### 10.3 A crashes after commit, before release

Lease TTL runs out. B acquires `fence:2`. B's intent sees A's
committed claim → `loser`. B escalates. No second mutate. A's stale
renew is `412 VR5010`.

### 10.4 A crashes after intent, before mutate

Claim is `claimed`, not `committed`. Lease expires. B acquires
`fence:2`.

```
B: POST /conflicts {phase:intent, fence:2, …}
   ← winner (A's claim superseded by higher fence + expired lease)
B: mutate
B: commit fence 2
```

A, if it later resumes with fence 1:

- `assertFences` / `renew` → `VR5010`.
- Mutate is forbidden. If A mutates anyway and reports `VR5006` or
  tries to commit fence 1 → `loser` (B committed) or `412`.

This is the in-doubt window: the world may or may not have A's write
if A crashed **during** mutate after intent. B MUST NOT assume A
failed. B's compensator still has to be idempotent (WHERE old values,
DELETE 404). If B's mutate hits `VR5006` because A actually landed:

```
B: POST /conflicts {error_code:VR5006, fence:2, …}
```

Nobody committed. Coordinator returns `in_doubt`. B escalates. That is
correct: two coordinated clients cannot prove who landed. A human or
probe (`effect_probed`) decides. The protocol's job is no **silent**
double-apply, not no escalation.

C3 crash-injection (“dead holder expires, waiter proceeds after TTL”)
covers 10.3 and the steal in 10.4. It does not require the coordinator
to probe the external resource.

### 10.5 Same process retry

Same `holder`+`fence` intent/commit is idempotent. Local
`idempotency_key` still dedupes attempts **inside** one SQLite file.
The coordinator does not see attempt rows in fence-only mode.

### 10.6 Multi-key plans

`acquireAll` sorts keys and acquires each in order; any `VR5005`
releases keys already held and retries until `waitMs`. The coordinator
sees independent per-key ops. Partial acquire is a client problem.
Conflict claims are per `resource_key`. A plan that mutates two keys
commits two claims. Losing either key before mutate means the client
releases the other and does not apply.

### 10.7 Algorithm (client, `coordinatorUrl` set)

For each sorted `resource_key` in the plan:

1. `acquire` via coordinator. On `VR5005` after `waitMs`, escalate
   `lease_unavailable`, stop.
2. Record `fencing_token` (and per-key map if multiple) on the in-memory
   held set. Persist fence on `AttemptRecord.fence` as today (primary
   key = sorted first).
3. `POST /conflicts` `{phase:"intent", ...}` for each key. On `loser`
   or `in_doubt`, release keys, escalate, stop. Do not mutate.
4. `assertFences` immediately before each step. `VR5010` → stop, do
   not mutate.
5. Mutate. On `VR5006`, `POST /conflicts` with `error_code:"VR5006"`,
   follow verdict, escalate, do not retry that step.
6. On success, `POST /conflicts` `{phase:"commit", ...}`, append local
   `compensation_executed` with additive `fencing_token`, `release`.

When `coordinatorUrl` is unset, skip 1's remote call (use the local
ledger's `leases` table), skip 3 and 6's `/conflicts`, and do not
write `fencing_token` on the receipt. Existing lease tests stay green.

## 11. What receipts record

No field is renamed. Additive only (`SPEC` §7).

`AttemptRecord.fence` already exists. It stays the attempt's fence for
the primary (sorted-first) resource key.

New optional fields, absent when the coordinator was not used:

On `compensation_executed` payload:

```json
{
  "plan_hash": "sha256:…",
  "attempt_ids": ["att_…"],
  "postconditions_ok": true,
  "reversal_completeness": "full",
  "leak": "none",
  "duration_ms": 40,
  "fencing_token": 3
}
```

On the sealed `EffectReceipt` (and its effect projection, via
`migrate.ts` new column when C3 lands):

```
fencing_token?: number
```

Meaning: the fence of the lexicographically first `resource_key` held
at execute time. Forensics that need every key read `AttemptRecord`
plus the coordinator conflict log. Do not add a map to the sealed
receipt in C3 unless a test requires it; additive scalar matches the
spec wording.

`fencing_token` is **not** part of `seal_hash` stability for old
receipts: old receipts omit it. New receipts that include it MUST
include it in the sealed body so the hash covers the token. C3 must
not rewrite historical events.

Hosted `/events` in shape (2) store the same payloads. Fence-only
shape (1) stores them only on the local SQLite chain. The coordinator
does not need the token to compute verdicts; claims already carry
`fence`.

## 12. Error map

| Situation | HTTP | `error_code` | Client |
|---|---|---|---|
| Live lease, other holder | 409 | VR5005 | `lease_unavailable`; wait or escalate |
| Stale fence on renew/release/claim | 412 | VR5010 | `fenced`; stop mutating |
| Coordinator down (lease RPC) | — | VR5005 | fail closed |
| Event hash mismatch | 200 with wrong `{hash}` or 4xx `{error_code:VR2015}` | VR2015 | refuse forged history |
| World concurrent modification | 200 from `/conflicts` | VR5006 in body | loser or in_doubt; escalate |
| Uncoordinated writer, holder still valid | 200 `verdict:in_doubt` | VR5006 | escalate; no retry |
| Auth | 401 | — | client already fails the RPC |

`VR5006` is never an HTTP status on `/leases`. It only appears on
`/conflicts` bodies and in local compensation failures.

## 13. Non-goals (checklist)

Repeated here so an implementation cannot “helpfully” grow them:

- No global lock manager; no tree of locks; no intent-log that locks
  a prefix.
- No long-lived leases. Clamp is 5 minutes. Compensations that need
  longer must heartbeat or they expire.
- No coordinator-side deadlock detection. Sorted client acquire only.
- No merging of SQLite files, no cross-ledger `prev_hash`.
- No 2PC with the external resource.
- No multi-instance coordinator.
- No pricing, tenants, or per-workspace isolation beyond bearer +
  bind address.
- No new compensator domains.
- No change to `VR5005` / `VR5010` / `VR5006` meanings in core.
- No requirement that `/events` be used when fencing two local
  ledgers.

## 14. Accept (C1)

This document is the accept for C1. C2 is a single SQLite process
speaking §8. C3 is `coordinatorUrl` + `tests/coordination.test.ts`:
two processes × two ledgers × one resource; conflicting compensations
serialize; loser escalates; no double-apply; dead holder expires;
waiter proceeds after TTL.

Until C2 exists, `openHttpLedger` still talks to whatever mock or
future server is behind the URL. This protocol is that server's
contract.
