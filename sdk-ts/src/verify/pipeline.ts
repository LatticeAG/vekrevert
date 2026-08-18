/** DRAFT -> COMPILE -> VERIFY orchestration. Builtins never enter this path. */

import {
  compilePlan,
  isPlanRejection,
  type CompensationPlan,
  type EffectReceipt,
  type PlanRejection,
  type VerificationRecord,
  type VekRevertConfig,
} from "@latticeag/vekrevert-core";
import { draftCompensation, draftedSignature, type DraftOpts } from "./drafter.ts";
import {
  recordToRejection,
  verificationPassesGate,
  verifyPlan,
  type VerifyOpts,
} from "./verifier.ts";

export function envAllowDrafted(): boolean {
  const v = process.env.VEKREVERT_ALLOW_DRAFTED;
  return v === "1" || v === "true" || v === "TRUE" || v === "yes";
}

export function workspaceAllowsDrafted(config?: Pick<VekRevertConfig, "allowDrafted">): boolean {
  return config?.allowDrafted === true || envAllowDrafted();
}

export function isPipelineRejection(v: PipelineOk | PlanRejection): v is PlanRejection {
  return (v as PlanRejection).ok === false;
}

export interface PipelineOpts {
  plan_id?: string;
  now?: Date;
  draft?: DraftOpts;
  verify?: VerifyOpts;
}

export interface PipelineOk {
  ok: true;
  plan: CompensationPlan;
  verification: VerificationRecord;
}

export async function draftCompileVerify(
  receipt: EffectReceipt,
  opts: PipelineOpts = {},
): Promise<PipelineOk | PlanRejection> {
  if (receipt.tier === "T4") {
    return { ok: false, error_code: "VR4005", stage: "drafted", detail: "drafted compensations are never used for T4" };
  }

  const drafted = await draftCompensation(receipt, { ...opts.draft, now: opts.now });
  if (!("steps" in drafted)) {
    return drafted;
  }

  const signature = draftedSignature(receipt, drafted.steps);
  const compiled = compilePlan(receipt, signature, {
    origin: "drafted",
    steps: drafted.steps,
    plan_id: opts.plan_id,
    now: opts.now,
  });
  if (isPlanRejection(compiled)) return compiled;

  const verification = await verifyPlan(compiled, receipt, {
    ...opts.verify,
    drafter_model: drafted.model,
    now: opts.now,
    signature,
  });
  compiled.verification = verification;
  if (!verificationPassesGate(verification)) {
    return recordToRejection(verification);
  }
  return { ok: true, plan: compiled, verification };
}
