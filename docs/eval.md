# Real-trace eval

This document closes the “fixtures only” gap. Numbers below were produced on
2026-09-07 by `pnpm exec tsx bench/eval_real_traces.ts` against frozen vectors
in `tests/fixtures/real_traces/frozen.json`. Reproduce with that command or
`vekrevert bench real-traces`. CI runs the same harness in
`tests/eval_real_traces.test.ts` (frozen set is well under a second here,
full `pnpm test` tens of seconds).

This is **not** a claim that VekRevert reversed the original Hermes sessions
on disk. Frozen traces rewrite paths to `/eval-sandbox`, redact file contents
and shell commands, and label ground truth from **tool identity** (a
`write_file` is a reversible overwrite; `terminal` is T4). OpenHands and
VersaTitan trajectories were not present on the eval host.

## Four numbers (frozen Hermes set, n=50 traces / 50 steps)

| Metric | Value |
|---|---|
| Reversal success | **100.0%** (20/20 fs write+patch sandboxes restored by `undo`) |
| False-escalation | **0.0%** (0/40 steps labelled `should_escalate=false`) |
| Receipt-chain integrity | **100.0%** |
| Added latency per tool call | **p50 ~0.03 ms / p99 ~1 ms** (classify only, memory ledger; host-dependent — rerun the harness) |

Synthetic control (existing 200-case red-team corpus, `bench/verifier_redteam/`):
compile-rejection recall **85.0%**, verifier false-PASS **0**. Classify fixtures
remain 120/120. Real-trace tier accuracy after the product fix: **100.0%**.

## Gap vs fixtures

The 120 classify fixtures never mention Hermes tool names. They already treat
`fs.write` as T2. Real sessions speak `write_file`, `patch`, `read_file`,
`web_search`, `terminal`. Without a mapper those land as `sdk_fn` /
`mcp_tool` → **T4 `mcp_unknown`**, so a production wrap of a Hermes-like
agent would escalate file writes that the fs compensator already knows how
to reverse. That is the gap the paper’s fixture scores hide.

Composition of the frozen set (redacted from `~/.hermes/state.db`, 1,056
sessions with tool calls; rebuild with `python3 scripts/freeze_real_traces.py`
when the DB is present):

- 12 `write_file` (T2, undo)
- 8 `patch` (T2, undo)
- 10 `read_file` (T1, no mutate)
- 10 `web_search` (T1 GET, no mutate)
- 10 `terminal` (T4, escalate — by design)

## Top-3 failure classes D2 found

1. **Agent file-write tools classified as unknown MCP (T4).** `write_file` /
   `patch` / `mcp__filesystem__write_file` are ordinary fs overwrites. This
   was the false-escalation class (~20/50 traces). **Fixed:**
   `rewriteAgentTool` in `packages/core/src/taxonomy.ts` (Python:
   `rewrite_agent_tool`) rewrites them to `fs.write` before structural
   classify.
2. **Agent file-read tools classified as T4.** `read_file` / `search_files`
   are T1 reads. Same rewrite, `fs.stat` / `fs.readdir`.
3. **`web_search` classified as T4.** Read-only HTTP GET. Same rewrite.

`terminal` / `execute_code` / unknown MCP stay T4. That is not a failure:
the eval does not invent a shell compensator (spec non-goal: no new
compensator domains).

After the taxonomy fix the frozen harness reports `failures none`. Unknown
`mcp.other.do` is still T4 (`tests/agent_file_tools.test.ts`).

## What this does not measure

- Live latency of `execute` / SQLite fsync on the original files.
- Drafted-plan quality on Hermes arguments (contents are redacted).
- Cross-ledger coordinator cost (Scope C is a separate gate).
- A hosted model SLA for the verifier; red-team control uses the structural
  verifier + compile rejection.

If the numbers regress, fail `tests/eval_real_traces.test.ts` rather than
editing this file first.
