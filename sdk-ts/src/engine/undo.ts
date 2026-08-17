/** LIFO undo over the sealed log (D12, D15, §8.2, §8.5). */

import {
  compilePlan,
  isPlanRejection,
  worldRestored,
  type CompensationPlan,
  type CompensationState,
  type EffectReceipt,
  type JsonValue,
  type UndoOptions,
  type UndoReport,
  type VRCode,
} from "@latticeag/vekrevert-core";
import { lowerSteps } from "@latticeag/vekrevert-compensators";
import { appendChained, projectionToReceipt, type EffectHost } from "../effect.ts";
import type { EffectProjection, Ledger } from "../ledger/types.ts";
import type { CompensatorRegistry } from "../registry.ts";
import { raise } from "../escalate/sink.ts";
import { executePlan, type ExecutePlanOpts } from "./execute.ts";
import { probeEffect, type ProbeOpts, type ProbeResult } from "./probe.ts";
import { VekRevertError } from "@latticeag/vekrevert-core";

const TERMINAL_SKIP = new Set<string>(["compensated", "none_required", "superseded", "manually_resolved"]);
const UNDO_STATUS = new Set(["landed", "in_doubt"]);

const ALLOWED: Record<string, ReadonlySet<string>> = {
  available: new Set(["planned", "escalated", "none_required", "unavailable"]),
  planned: new Set(["verified", "executing", "escalated"]),
  verified: new Set(["executing", "escalated"]),
  executing: new Set(["compensated", "failed", "in_doubt", "escalated"]),
  failed: new Set(["escalated"]),
  in_doubt: new Set(["compensated", "failed", "escalated", "none_required"]),
  escalated: new Set(["manually_resolved"]),
  unavailable: new Set(["escalated"]),
  none_required: new Set(),
  compensated: new Set(),
  superseded: new Set(),
  manually_resolved: new Set(),
};

export function transition(from: CompensationState, to: CompensationState): CompensationState {
  if (from === to) return to;
  const ok = ALLOWED[from];
  if (!ok || !ok.has(to)) throw new VekRevertError("VR5012", `${from} -> ${to}`);
  return to;
}

export interface UndoEngineOpts extends UndoOptions {
  ledger: Ledger;
  host: EffectHost;
  registry: CompensatorRegistry;
  fetch?: ExecutePlanOpts["fetch"];
  db?: ExecutePlanOpts["db"];
  mcpCall?: ExecutePlanOpts["mcpCall"];
  credentials?: ExecutePlanOpts["credentials"];
  lease?: ExecutePlanOpts["lease"];
  sleep?: ExecutePlanOpts["sleep"];
  probe?: ProbeOpts["probe"];
  probeOpts?: ProbeOpts;
  now?: Date;
  haltOnFailure?: boolean;
}

type ReportRow = UndoReport["effects"][number];

function rowOutcome(
  row: EffectProjection,
  outcome: ReportRow["outcome"],
  extra?: Partial<ReportRow>,
): ReportRow {
  return {
    seq: row.seq,
    effect_id: row.effect_id,
    action: row.action_name,
    tier: row.tier as ReportRow["tier"],
    outcome,
    reversal_completeness: extra?.reversal_completeness,
    leak: (extra?.leak ?? row.leak) as ReportRow["leak"],
    error_code: extra?.error_code,
    escalation_id: extra?.escalation_id,
  };
}

async function persistState(ledger: Ledger, row: EffectProjection, state: CompensationState): Promise<void> {
  row.compensation_state = state;
  await ledger.upsertEffect(row);
}

async function resolveInDoubt(
  row: EffectProjection,
  receipt: EffectReceipt,
  opts: UndoEngineOpts,
): Promise<{ result: ProbeResult; blocked: boolean }> {
  const probed = await probeEffect(receipt, {
    ...(opts.probeOpts ?? {}),
    probe: opts.probe,
    fetch: opts.fetch,
    db: opts.db as ProbeOpts["db"],
    sleep: opts.sleep,
    backoffMs: opts.probeOpts?.backoffMs ?? [1, 1, 1],
  });
  await appendChained(
    opts.ledger,
    row.saga_id,
    "effect_probed",
    { probe_result: probed, attempts: 3 } as unknown as JsonValue,
    opts.host,
    row.effect_id,
  );
  if (probed === "landed") {
    row.status = "landed";
    await opts.ledger.upsertEffect(row);
    return { result: probed, blocked: false };
  }
  if (probed === "not_landed") {
    row.status = "abandoned";
    await persistState(opts.ledger, row, "none_required");
    await appendChained(
      opts.ledger,
      row.saga_id,
      "compensation_skipped",
      { reason: "abandoned" } as unknown as JsonValue,
      opts.host,
      row.effect_id,
    );
    return { result: probed, blocked: false };
  }
  await raise({
    ledger: opts.ledger,
    host: opts.host,
    saga_id: row.saga_id,
    effect_id: row.effect_id,
    reason_code: "unresolved_in_doubt",
  });
  return { result: probed, blocked: true };
}

async function compileFor(row: EffectProjection, receipt: EffectReceipt, opts: UndoEngineOpts): Promise<CompensationPlan | { error_code: VRCode; detail: string }> {
  const matched = opts.registry.match(receipt.action, receipt.args_observed, receipt.result_observed);
  if (!matched.matched) return { error_code: "VR3001", detail: "no compensator match" };
  const lowered = lowerSteps(matched.matched, receipt);
  const plan = compilePlan(receipt, matched.matched, {
    origin: matched.matched.source,
    ...(lowered ? { steps: lowered.steps } : {}),
    now: opts.now,
  });
  if (isPlanRejection(plan)) return { error_code: plan.error_code, detail: plan.detail };
  return plan;
}

export async function undoSaga(sagaId: string, opts: UndoEngineOpts): Promise<UndoReport> {
  const ledger = opts.ledger;
  const saga = await ledger.getSaga(sagaId);
  if (!saga) throw new VekRevertError("VR3001", `unknown saga ${sagaId}`);

  const haltOnFailure = opts.haltOnFailure !== false && opts.continueOnFailure !== true;
  const requested_at = (opts.now ?? new Date()).toISOString();

  if (!opts.dryRun) {
    saga.status = "undoing";
    await ledger.upsertSaga(saga);
  }

  const all = (await ledger.listEffects(sagaId)).sort((a, b) => b.seq - a.seq);
  const selected = all.filter(
    (e) => UNDO_STATUS.has(e.status) && !TERMINAL_SKIP.has(e.compensation_state),
  );
  const toSeq = opts.toSeq;
  const work: EffectProjection[] = [];
  for (const e of selected) {
    if (toSeq != null && e.seq < toSeq) continue;
    work.push(e);
    if (toSeq != null && e.seq === toSeq) {
      /* inclusive stop after this seq; remaining lower already skipped by seq < toSeq */
    }
  }

  const effects: ReportRow[] = [];
  let halted_at_seq: number | undefined;
  let halt = false;
  let haltError: VekRevertError | undefined;

  for (const row of all) {
    if (halt) {
      if (work.some((w) => w.effect_id === row.effect_id) || (toSeq == null || row.seq >= toSeq)) {
        if (!TERMINAL_SKIP.has(row.compensation_state) && UNDO_STATUS.has(row.status) && (toSeq == null || row.seq >= toSeq)) {
          effects.push(rowOutcome(row, "not_attempted"));
        }
      }
      continue;
    }
    if (!work.some((w) => w.effect_id === row.effect_id)) {
      if (toSeq != null && row.seq < toSeq && UNDO_STATUS.has(row.status) && !TERMINAL_SKIP.has(row.compensation_state)) {
        effects.push(rowOutcome(row, "not_attempted"));
      }
      continue;
    }

    const receipt = projectionToReceipt(row);
    const independent = opts.registry.match(receipt.action, receipt.args_observed, receipt.result_observed).matched?.independent === true;

    if (row.status === "in_doubt") {
      const { result, blocked } = await resolveInDoubt(row, receipt, opts);
      if (blocked) {
        const { escalation_id } = await raise({
          ledger,
          host: opts.host,
          saga_id: sagaId,
          effect_id: row.effect_id,
          reason_code: "unresolved_in_doubt",
        }).catch(() => ({ escalation_id: undefined }));
        effects.push(
          rowOutcome(row, "escalated", { error_code: "VR5011", escalation_id, leak: row.leak as ReportRow["leak"] }),
        );
        halted_at_seq = row.seq;
        halt = true;
        haltError = new VekRevertError("VR5011", "in_doubt_blocks_undo");
        continue;
      }
      if (result === "not_landed") {
        effects.push(rowOutcome(row, "skipped", { reversal_completeness: "full" }));
        continue;
      }
    }

    if (opts.dryRun) {
      effects.push(
        rowOutcome(row, "skipped", {
          reversal_completeness: "full",
          leak: row.leak as ReportRow["leak"],
        }),
      );
      continue;
    }

    if (row.compensation_state === "unavailable") {
      const { escalation_id } = await raise({
        ledger,
        host: opts.host,
        saga_id: sagaId,
        effect_id: row.effect_id,
        reason_code: row.tier === "T4" ? "t4_irreversible" : "compile_rejected",
      });
      await persistState(ledger, row, transition("unavailable", "escalated"));
      effects.push(rowOutcome(row, "escalated", { error_code: row.tier === "T4" ? "VR1010" : "VR3001", escalation_id }));
      if (haltOnFailure && !independent) {
        halted_at_seq = row.seq;
        halt = true;
      }
      continue;
    }

    try {
      if (row.compensation_state === "available") transition("available", "planned");
    } catch (err) {
      if (err instanceof VekRevertError && err.code === "VR5012") {
        if (row.compensation_state === "executing" || row.compensation_state === "planned" || row.compensation_state === "verified") {
          /* resume */
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    if (row.compensation_state === "available") {
      await persistState(ledger, row, "planned");
      await appendChained(
        ledger,
        sagaId,
        "compensation_planned",
        {
          plan_id: "",
          plan_hash: "",
          compensator_id: row.compensator_id ?? "",
          origin: "builtin",
          step_kinds: [],
        } as unknown as JsonValue,
        opts.host,
        row.effect_id,
      );
    }

    const compiled = await compileFor(row, receipt, opts);
    if ("error_code" in compiled && !("plan_id" in compiled)) {
      await raise({
        ledger,
        host: opts.host,
        saga_id: sagaId,
        effect_id: row.effect_id,
        reason_code: compiled.error_code === "VR5007" ? "window_expired" : "compile_rejected",
        approval_binds_to: undefined,
      });
      await persistState(ledger, row, transition(row.compensation_state as CompensationState, "escalated"));
      effects.push(rowOutcome(row, "escalated", { error_code: compiled.error_code }));
      if (haltOnFailure && !independent) {
        halted_at_seq = row.seq;
        halt = true;
      }
      continue;
    }
    const plan = compiled as CompensationPlan;

    await appendChained(
      ledger,
      sagaId,
      "compensation_planned",
      {
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        compensator_id: plan.compensator_id,
        origin: plan.origin,
        step_kinds: plan.steps.map((s) => s.kind),
      } as unknown as JsonValue,
      opts.host,
      row.effect_id,
    );

    if (plan.steps.some((s) => s.kind === "manual") || receipt.tier === "T4") {
      const { escalation_id } = await raise({
        ledger,
        host: opts.host,
        saga_id: sagaId,
        effect_id: row.effect_id,
        reason_code: "t4_irreversible",
        approval_binds_to: plan.plan_hash,
      });
      await persistState(ledger, row, "escalated");
      effects.push(rowOutcome(row, "manual_required", { error_code: "VR1010", escalation_id, reversal_completeness: plan.reversal_completeness, leak: plan.leak }));
      if (haltOnFailure && !independent) {
        halted_at_seq = row.seq;
        halt = true;
      }
      continue;
    }

    if (plan.cascade_risk === "high") {
      const { escalation_id } = await raise({
        ledger,
        host: opts.host,
        saga_id: sagaId,
        effect_id: row.effect_id,
        reason_code: "cascade_risk",
        approval_binds_to: plan.plan_hash,
      });
      await persistState(ledger, row, "escalated");
      effects.push(rowOutcome(row, "escalated", { error_code: "VR1010", escalation_id, reversal_completeness: plan.reversal_completeness, leak: plan.leak }));
      if (haltOnFailure && !independent) {
        halted_at_seq = row.seq;
        halt = true;
      }
      continue;
    }

    await persistState(ledger, row, transition(row.compensation_state as CompensationState, "executing"));

    try {
      const result = await executePlan(plan, {
        ledger,
        host: opts.host,
        registry: opts.registry,
        fetch: opts.fetch,
        db: opts.db,
        mcpCall: opts.mcpCall,
        credentials: opts.credentials,
        lease: opts.lease,
        sleep: opts.sleep,
        probe: opts.probe,
        probeOpts: opts.probeOpts,
        now: opts.now,
        allowDrafted: opts.allowDrafted,
      });
      if (!result.ok) {
        await persistState(ledger, row, "escalated");
        effects.push(
          rowOutcome(row, "escalated", {
            error_code: result.error_code,
            reversal_completeness: plan.reversal_completeness,
            leak: plan.leak,
          }),
        );
        if (haltOnFailure && !independent) {
          halted_at_seq = row.seq;
          halt = true;
        }
        continue;
      }
      await persistState(ledger, row, transition("executing", "compensated"));
      effects.push(
        rowOutcome(row, "compensated", {
          reversal_completeness: plan.reversal_completeness,
          leak: plan.leak,
        }),
      );
    } catch (err) {
      const ve = err instanceof VekRevertError ? err : new VekRevertError("VR5001", err instanceof Error ? err.message : String(err));
      if (ve.code === "VR5010") throw ve;
      if (ve.code === "VR5012") throw ve;
      if (ve.code === "VR2020") {
        const { escalation_id } = await raise({
          ledger,
          host: opts.host,
          saga_id: sagaId,
          effect_id: row.effect_id,
          reason_code: "unresolved_in_doubt",
        });
        await persistState(ledger, row, "escalated");
        effects.push(rowOutcome(row, "escalated", { error_code: "VR5011", escalation_id }));
        halted_at_seq = row.seq;
        halt = true;
        haltError = new VekRevertError("VR5011", "in_doubt_blocks_undo");
        continue;
      }
      try {
        await persistState(ledger, row, transition("executing", "failed"));
      } catch {
        row.compensation_state = "failed";
        await ledger.upsertEffect(row);
      }
      const alreadyFailed = (await ledger.readSaga(sagaId)).some(
        (ev) => ev.type === "compensation_failed" && ev.effect_id === row.effect_id,
      );
      if (!alreadyFailed) {
        await appendChained(
          ledger,
          sagaId,
          "compensation_failed",
          {
            error_code: ve.code,
            step_index: 0,
            attempts: 1,
            postcondition_failed: ve.code === "VR5002",
          } as unknown as JsonValue,
          opts.host,
          row.effect_id,
        );
      }
      const { escalation_id } = await raise({
        ledger,
        host: opts.host,
        saga_id: sagaId,
        effect_id: row.effect_id,
        reason_code: ve.code === "VR5005" ? "lease_unavailable" : ve.code === "VR5007" ? "window_expired" : "compensation_failed",
        approval_binds_to: plan.plan_hash,
      });
      await persistState(ledger, row, "escalated");
      effects.push(
        rowOutcome(row, independent && haltOnFailure ? "failed" : haltOnFailure ? "failed" : "failed", {
          error_code: ve.code,
          escalation_id,
          reversal_completeness: plan.reversal_completeness,
          leak: plan.leak,
        }),
      );
      if (haltOnFailure && !independent) {
        halted_at_seq = row.seq;
        halt = true;
      }
    }
  }

  const attempted = effects.filter((e) => e.outcome !== "not_attempted").length;
  const compensated = effects.filter((e) => e.outcome === "compensated").length;
  const skipped = effects.filter((e) => e.outcome === "skipped").length;
  const failed = effects.filter((e) => e.outcome === "failed").length;
  const escalated = effects.filter((e) => e.outcome === "escalated" || e.outcome === "manual_required").length;

  const report: UndoReport = {
    saga_id: sagaId,
    requested_at,
    attempted,
    compensated,
    skipped,
    failed,
    escalated,
    ...(halted_at_seq != null ? { halted_at_seq } : {}),
    effects,
    world_restored: worldRestored(effects),
  };

  if (!opts.dryRun) {
    const finalStatus =
      report.world_restored || (failed === 0 && escalated === 0 && effects.every((e) => e.outcome === "compensated" || e.outcome === "skipped"))
        ? "undone"
        : compensated > 0 || failed > 0 || escalated > 0
          ? "partially_undone"
          : "failed";
    await appendChained(
      ledger,
      sagaId,
      "saga_undone",
      { ...report, status: finalStatus } as unknown as JsonValue,
      opts.host,
    );
    const s = await ledger.getSaga(sagaId);
    if (s) {
      s.status = finalStatus;
      await ledger.upsertSaga(s);
    }
  }

  if (haltError) throw haltError;
  return report;
}
