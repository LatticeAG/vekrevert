/** Honest reversal reporting (D17). */

import type { CompensationPlan, EffectReceipt, UndoReport } from "./types.ts";

export function whatUndoDoesNotFix(input: {
  leak: EffectReceipt["leak"] | CompensationPlan["leak"];
  cascade_risk: EffectReceipt["cascade_risk"] | CompensationPlan["cascade_risk"];
  reversal_completeness: CompensationPlan["reversal_completeness"];
}): string[] {
  const out: string[] = [];
  if (input.leak === "observers") out.push("observers retain knowledge of the original action");
  if (input.leak === "downstream_effects") out.push("downstream effects are not rewound");
  if (input.cascade_risk === "high") out.push("undeclared cascades were not repaired");
  if (input.cascade_risk === "low") out.push("watchers or side channels may already have reacted");
  if (input.reversal_completeness === "partial") out.push("reversal is partial, not a full restore of prior state");
  if (input.reversal_completeness === "best_effort") out.push("the remote system only promised to try");
  if (out.length === 0) out.push("reversal restores state, not knowledge; this is not erasure");
  return out;
}

export function worldRestored(effects: UndoReport["effects"]): boolean {
  if (effects.length === 0) return false;
  return effects.every((e) => e.outcome === "compensated" && e.reversal_completeness === "full");
}

export function worldRestoredFromReport(report: Pick<UndoReport, "effects" | "attempted">): boolean {
  const attempted = report.effects.filter((e) => e.outcome !== "not_attempted" && e.outcome !== "skipped");
  if (attempted.length === 0) return false;
  if (!attempted.every((e) => e.outcome === "compensated" && e.reversal_completeness === "full")) return false;
  if (report.effects.some((e) => e.outcome === "failed" || e.outcome === "escalated" || e.outcome === "manual_required")) {
    return false;
  }
  return worldRestored(report.effects.filter((e) => e.outcome === "compensated"));
}
