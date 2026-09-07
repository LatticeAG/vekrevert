/** Real-trace eval harness (SPEC-V1-GAPS-EVAL Scope D). Frozen vectors only — no live Hermes. */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyAction,
  compilePlan,
  isPlanRejection,
  rewriteAgentTool,
  verifyChain,
  type ActionRef,
  type CompensationStep,
  type EffectReceipt,
  type JsonValue,
  type Tier,
} from "@latticeag/vekrevert-core";
import { draftedSignature, verifyPlan, verificationPassesGate, VekRevert } from "@latticeag/vekrevert";

export interface TraceStep {
  seq: number;
  tool: string;
  action: ActionRef;
  args: JsonValue;
  run_fixture?: { kind: string; pre_text?: string; post_text?: string };
  labels: {
    had_side_effect: boolean;
    expected_tier: Tier;
    expected_compensator?: string;
    reversal_success: boolean;
    should_escalate: boolean;
  };
}

export interface FrozenTrace {
  v: string;
  id: string;
  source: { system: string; session_hash?: string; tool?: string };
  class: string;
  writable_roots?: string[];
  steps: TraceStep[];
  ground_truth: { full_undo_restores_world: boolean; receipt_chain_valid: boolean };
}

export interface EvalReport {
  traces: number;
  steps: number;
  reversal_success_rate: number;
  false_escalation_rate: number;
  receipt_chain_integrity: number;
  latency_ms: { p50: number; p99: number };
  tier_accuracy: number;
  failure_classes: Array<{ class: string; count: number }>;
  control: { redteam_n: number; compile_rejection_recall: number; verifier_false_pass: number };
  gap_vs_fixtures: { classify_fixture_n: number; real_trace_tier_accuracy: number };
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function percentile(samples: number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx]!;
}

function loadFrozen(path = join(repoRoot(), "tests/fixtures/real_traces/frozen.json")): FrozenTrace[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { traces: FrozenTrace[] };
  return raw.traces;
}

function captureFs(path: string) {
  return (): { kind: "fs_absent" | "fs_bytes"; bytes?: Uint8Array; meta: Record<string, string | number> } => {
    if (!existsSync(path)) return { kind: "fs_absent", meta: { realpath: path } };
    const bytes = new Uint8Array(readFileSync(path));
    const st = lstatSync(path);
    return {
      kind: "fs_bytes",
      bytes,
      meta: {
        realpath: path,
        mode: st.mode,
        uid: st.uid,
        gid: st.gid,
        mtime_ns: Math.round(st.mtimeMs * 1e6),
        dev: st.dev,
        ino: Number(st.ino),
        size: st.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  };
}

function remapPath(evalPath: string, root: string): string {
  return join(root, evalPath.replace(/^\/eval-sandbox\//, ""));
}

async function scoreRedteam(corpusDir: string): Promise<{ n: number; recall: number; falsePass: number }> {
  if (!existsSync(corpusDir)) return { n: 0, recall: 0, falsePass: 0 };
  const files = readdirSync(corpusDir).filter((f) => f.endsWith(".json"));
  let compileRejected = 0;
  let falsePass = 0;
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(corpusDir, file), "utf8")) as {
      receipt: EffectReceipt;
      plan: { steps: CompensationStep[] };
    };
    const sig = draftedSignature(raw.receipt, raw.plan.steps);
    const compiled = compilePlan(raw.receipt, sig, { origin: "drafted", steps: raw.plan.steps, plan_id: `cpl_rt_${file}` });
    if (isPlanRejection(compiled)) {
      compileRejected += 1;
      continue;
    }
    const rec = await verifyPlan(compiled, raw.receipt, { signature: sig });
    if (verificationPassesGate(rec)) falsePass += 1;
  }
  return { n: files.length, recall: files.length ? compileRejected / files.length : 0, falsePass };
}

export async function evalRealTraces(opts?: { tracesPath?: string; redteamDir?: string }): Promise<EvalReport> {
  const traces = loadFrozen(opts?.tracesPath);
  const failures = new Map<string, number>();
  const bump = (k: string) => failures.set(k, (failures.get(k) ?? 0) + 1);
  const latencies: number[] = [];
  let stepsN = 0;
  let tierOk = 0;
  let reversalDenom = 0;
  let reversalOk = 0;
  let falseEsc = 0;
  let noFalseEscDenom = 0;
  let chainOk = 0;
  let chainDenom = 0;

  for (const trace of traces) {
    const sandbox = mkdtempSync(join(tmpdir(), `vr-eval-${trace.id}-`));
    const v = new VekRevert({
      ledger: "memory",
      writableRoots: [sandbox],
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: trace.id });
    let recordedSideEffect = false;
    try {
      for (const step of trace.steps) {
        stepsN += 1;
        const t0 = performance.now();
        const rec = classifyAction(step.action, step.args, { writableRoots: ["/eval-sandbox"] });
        latencies.push(performance.now() - t0);
        if (rec.tier === step.labels.expected_tier) tierOk += 1;
        else bump(`tier_mismatch:${step.tool}:${rec.tier}`);

        if (!step.labels.should_escalate) {
          noFalseEscDenom += 1;
          if (rec.tier === "T4") {
            falseEsc += 1;
            bump("false_escalation_t4");
          }
        }

        if (step.labels.reversal_success && step.run_fixture?.kind === "inline_fs") {
          reversalDenom += 1;
          const aliased = rewriteAgentTool(step.action, step.args);
          const fsAction = aliased?.action ?? step.action;
          const fsArgs = (aliased?.args ?? step.args) as Record<string, JsonValue>;
          const evalPath = String(fsArgs.path ?? fsAction.target ?? "");
          const realPath = remapPath(evalPath, sandbox);
          mkdirSync(dirname(realPath), { recursive: true });
          const pre = step.run_fixture.pre_text ?? "old";
          const post = step.run_fixture.post_text ?? "new";
          writeFileSync(realPath, pre);
          await saga.effect({
            action: fsAction,
            args: { ...fsArgs, path: realPath, realpath: realPath, op: "write" },
            capturePreimage: captureFs(realPath),
            run: async () => {
              writeFileSync(realPath, post);
              return { ok: true };
            },
          });
          recordedSideEffect = true;
        }
      }

      if (recordedSideEffect) {
        const report = await v.undo(saga.id);
        const receipts = await v.receipts(saga.id, { verifyChain: true });
        chainDenom += 1;
        if (receipts.chain_ok === true) chainOk += 1;
        else bump("chain_broken");
        let restored = true;
        for (const step of trace.steps) {
          if (!step.labels.reversal_success || step.run_fixture?.kind !== "inline_fs") continue;
          const aliased = rewriteAgentTool(step.action, step.args);
          const evalPath = String(
            (aliased?.args as Record<string, JsonValue> | undefined)?.path ?? step.action.target ?? "",
          );
          const realPath = remapPath(evalPath, sandbox);
          const want = step.run_fixture.pre_text ?? "old";
          if (!existsSync(realPath) || readFileSync(realPath, "utf8") !== want) {
            restored = false;
            bump("undo_bytes_mismatch");
          }
        }
        if (restored && report.compensated >= 1) reversalOk += 1;
        else {
          bump("reversal_failed");
          if (!trace.ground_truth.full_undo_restores_world) {
            /* labelled not to restore */
          }
        }
        void verifyChain;
      } else {
        const receipts = await v.receipts(saga.id, { verifyChain: true });
        chainDenom += 1;
        if (receipts.chain_ok !== false) chainOk += 1;
      }
    } finally {
      await v.ledgerHandle?.close().catch(() => undefined);
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  const control = await scoreRedteam(opts?.redteamDir ?? join(repoRoot(), "bench/verifier_redteam"));
  const classifyFixtureN = 120;

  return {
    traces: traces.length,
    steps: stepsN,
    reversal_success_rate: reversalDenom ? reversalOk / reversalDenom : 1,
    false_escalation_rate: noFalseEscDenom ? falseEsc / noFalseEscDenom : 0,
    receipt_chain_integrity: chainDenom ? chainOk / chainDenom : 1,
    latency_ms: { p50: percentile(latencies, 0.5), p99: percentile(latencies, 0.99) },
    tier_accuracy: stepsN ? tierOk / stepsN : 1,
    failure_classes: [...failures.entries()]
      .map(([k, count]) => ({ class: k, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    control: {
      redteam_n: control.n,
      compile_rejection_recall: control.recall,
      verifier_false_pass: control.falsePass,
    },
    gap_vs_fixtures: { classify_fixture_n: classifyFixtureN, real_trace_tier_accuracy: stepsN ? tierOk / stepsN : 1 },
  };
}

export function formatEvalReport(r: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `traces ${r.traces} steps ${r.steps}`,
    `reversal_success ${pct(r.reversal_success_rate)}`,
    `false_escalation ${pct(r.false_escalation_rate)}`,
    `receipt_chain_integrity ${pct(r.receipt_chain_integrity)}`,
    `latency_ms p50=${r.latency_ms.p50.toFixed(3)} p99=${r.latency_ms.p99.toFixed(3)}`,
    `tier_accuracy ${pct(r.tier_accuracy)}`,
    `control redteam_n=${r.control.redteam_n} compile_rejection_recall=${pct(r.control.compile_rejection_recall)} verifier_false_pass=${r.control.verifier_false_pass}`,
    `gap classify_fixtures=${r.gap_vs_fixtures.classify_fixture_n} real_trace_tier_accuracy=${pct(r.gap_vs_fixtures.real_trace_tier_accuracy)}`,
    `failures ${r.failure_classes.length ? r.failure_classes.map((f) => `${f.class}=${f.count}`).join(", ") : "none"}`,
  ];
  return lines.join("\n") + "\n";
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const report = await evalRealTraces();
  process.stdout.write(formatEvalReport(report));
}
