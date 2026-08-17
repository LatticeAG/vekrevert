/** EP5 VekInbox client: raise + onResume. Approval binds to plan_hash (D18). */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  WEBHOOK_MAX_TIMESTAMP_SKEW_MS,
  assertProvenance,
  assertScope,
  compilePlan,
  isPlanRejection,
  isRef,
  planHash,
  resolveRef,
  whatUndoDoesNotFix,
  VekRevertError,
  type ActionSignature,
  type CompensationPlan,
  type EffectReceipt,
  type EscalationReasonCode,
  type JsonValue,
} from "@latticeag/vekrevert-core";
import { appendChained, projectionToReceipt, type EffectHost } from "../effect.ts";
import { executePlan } from "../engine/execute.ts";
import { raise as sinkRaise } from "./sink.ts";
import type { Ledger } from "../ledger/types.ts";
import { newEscalationId } from "../ulid.ts";
import { redactArgs } from "../redact.ts";

export { WEBHOOK_MAX_TIMESTAMP_SKEW_MS };

const PRIORITY: Record<EscalationReasonCode, string> = {
  t4_irreversible: "critical",
  unresolved_in_doubt: "critical",
  compensation_failed: "high",
  lease_unavailable: "high",
  cascade_risk: "high",
  verifier_rejected: "high",
  compile_rejected: "normal",
  window_expired: "normal",
  drafted_not_allowed: "normal",
};

const ACTIONS: Record<EscalationReasonCode, string[]> = {
  t4_irreversible: ["mark_manually_resolved", "decline"],
  verifier_rejected: ["approve_compensation", "decline", "request_changes"],
  compile_rejected: ["decline", "request_changes"],
  compensation_failed: ["approve_compensation", "mark_manually_resolved", "decline"],
  unresolved_in_doubt: ["mark_manually_resolved", "decline"],
  lease_unavailable: ["approve_compensation", "decline"],
  window_expired: ["mark_manually_resolved", "decline"],
  cascade_risk: ["approve_compensation", "decline"],
  drafted_not_allowed: ["approve_compensation", "decline"],
};

export interface VekRevertEscalation {
  v: "vekrevert/v1";
  reason_code: EscalationReasonCode;
  saga_id: string;
  effect: {
    effect_id: string;
    seq: number;
    action: EffectReceipt["action"];
    tier: EffectReceipt["tier"];
    opened_at: string;
    closed_at?: string;
    status: EffectReceipt["status"];
    args_observed: JsonValue;
    args_hash: string;
    result_observed?: JsonValue;
    bindings: Record<string, JsonValue>;
    resource_keys: string[];
    capture_fidelity: string;
  };
  proposed_plan?: {
    plan_id: string;
    plan_hash: string;
    compensator_id: string;
    origin: "builtin" | "registered" | "drafted";
    rendered_steps: string[];
    reversal_completeness: "full" | "partial" | "best_effort";
    leak: "none" | "observers" | "downstream_effects";
    cascade_risk: "none" | "low" | "high";
  };
  verification?: unknown;
  failure?: { error_code: string; message: string; step_index: number; attempts: number };
  risk: {
    summary: string;
    blast_radius: string[];
    what_undo_does_not_fix: string[];
    reversible_if_approved: boolean;
  };
  ledger: { chain_head: string; receipt_events: string[] };
  approval_binds_to: string;
}

export interface StoredEscalation {
  escalation_id: string;
  key: string;
  payload: VekRevertEscalation;
  plan?: CompensationPlan;
  receipt: EffectReceipt;
  signature?: ActionSignature;
  saga_id: string;
  effect_id: string;
  vekinbox_request_id?: string;
}

const store = new Map<string, StoredEscalation>();
const byEscalationId = new Map<string, StoredEscalation>();

export function getStoredEscalation(key: string): StoredEscalation | undefined {
  return store.get(key) ?? byEscalationId.get(key);
}

export function listStoredEscalations(): StoredEscalation[] {
  return [...byEscalationId.values()];
}

export interface RaiseOpts {
  ledger: Ledger;
  host: EffectHost;
  saga_id: string;
  effect_id: string;
  reason_code: EscalationReasonCode;
  plan?: CompensationPlan;
  receipt?: EffectReceipt;
  signature?: ActionSignature;
  priority?: string;
  fetch?: typeof fetch;
}

function webhookSecret(host: EffectHost): string {
  return process.env.VEKINBOX_WEBHOOK_SECRET ?? "";
}

function resumeWebhookUrl(host: EffectHost): string | undefined {
  return host.config.escalation?.resumeWebhook ?? host.config.escalation?.vekinbox?.resumeWebhook;
}

function baseUrl(host: EffectHost): string | undefined {
  const u = host.config.escalation?.vekinbox?.baseUrl;
  return u && u.length > 0 ? u.replace(/\/$/, "") : undefined;
}

function titleFor(reason: EscalationReasonCode, actionName: string): string {
  if (reason === "t4_irreversible") return `Irreversible action needs review: ${actionName}`;
  return `Undo failed: ${actionName}`;
}

function descriptionFor(meta: VekRevertEscalation): string {
  const steps = meta.proposed_plan?.rendered_steps?.length
    ? meta.proposed_plan.rendered_steps.map((s) => `- ${s}`).join("\n")
    : "- (no compiled steps)";
  const missing = meta.risk.what_undo_does_not_fix.map((s) => `- ${s}`).join("\n");
  return `## Proposed compensation\n\n${steps}\n\n## What undo does not fix\n\n${missing}\n`;
}

export async function raise(opts: RaiseOpts): Promise<{ escalation_id: string; key: string; payload: VekRevertEscalation }> {
  const row = await opts.ledger.getEffect(opts.effect_id);
  if (!row) throw new VekRevertError("VR3001", `unknown effect ${opts.effect_id}`);
  const receipt = opts.receipt ?? projectionToReceipt(row);
  const redacted = redactArgs(receipt.args_observed, {
    paths: opts.host.config.redact?.paths,
    patterns: opts.host.config.redact?.patterns,
  });
  let plan = opts.plan;
  let signature = opts.signature;
  if (!plan && opts.host.registry) {
    const matched = opts.host.registry.match(receipt.action, receipt.args_observed, receipt.result_observed);
    if (matched.matched) {
      signature = matched.matched;
      const compiled = compilePlan(receipt, matched.matched, { origin: matched.matched.source });
      if (!isPlanRejection(compiled)) plan = compiled;
    }
  }
  const approval_binds_to = plan?.plan_hash ?? "";
  const leak = plan?.leak ?? receipt.leak;
  const cascade = plan?.cascade_risk ?? receipt.cascade_risk;
  const completeness = plan?.reversal_completeness ?? "best_effort";
  const missing = whatUndoDoesNotFix({ leak, cascade_risk: cascade, reversal_completeness: completeness });
  const saga = await opts.ledger.getSaga(opts.saga_id);
  const events = await opts.ledger.readSaga(opts.saga_id);
  const payload: VekRevertEscalation = {
    v: "vekrevert/v1",
    reason_code: opts.reason_code,
    saga_id: opts.saga_id,
    effect: {
      effect_id: receipt.effect_id,
      seq: receipt.seq,
      action: receipt.action,
      tier: receipt.tier,
      opened_at: receipt.opened_at,
      closed_at: receipt.closed_at,
      status: receipt.status,
      args_observed: redacted.args_observed,
      args_hash: receipt.args_hash,
      result_observed: receipt.result_observed,
      bindings: receipt.bindings,
      resource_keys: receipt.resource_keys,
      capture_fidelity: receipt.capture.fidelity,
    },
    ...(plan
      ? {
          proposed_plan: {
            plan_id: plan.plan_id,
            plan_hash: plan.plan_hash,
            compensator_id: plan.compensator_id,
            origin: plan.origin,
            rendered_steps: [plan.summary],
            reversal_completeness: plan.reversal_completeness,
            leak: plan.leak,
            cascade_risk: plan.cascade_risk,
          },
        }
      : {}),
    risk: {
      summary: `${opts.reason_code} on ${receipt.action.name}`,
      blast_radius: receipt.resource_keys,
      what_undo_does_not_fix: missing,
      reversible_if_approved: Boolean(plan) && plan!.origin !== "drafted" && receipt.tier !== "T4",
    },
    ledger: {
      chain_head: saga?.chain_head ?? "",
      receipt_events: events.map((e) => e.id),
    },
    approval_binds_to,
  };

  const key = `vekrevert.${opts.saga_id}.${receipt.seq}.${opts.reason_code}`;
  const escalation_id = newEscalationId();
  const priority = opts.priority ?? PRIORITY[opts.reason_code] ?? "high";
  const stored: StoredEscalation = {
    escalation_id,
    key,
    payload,
    plan,
    receipt,
    signature,
    saga_id: opts.saga_id,
    effect_id: opts.effect_id,
  };

  const inbox = baseUrl(opts.host);
  if (inbox) {
    const title = titleFor(opts.reason_code, receipt.action.name);
    const body = {
      workspace_id: opts.host.config.escalation?.vekinbox?.workspaceId,
      title,
      description: descriptionFor(payload),
      priority,
      actions: ACTIONS[opts.reason_code],
      key,
      metadata: payload,
      resume_webhook_url: resumeWebhookUrl(opts.host),
    };
    const doFetch = opts.fetch ?? opts.host.fetch ?? globalThis.fetch;
    try {
      const res = await doFetch(`${inbox}/requests`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.host.config.escalation?.vekinbox?.apiKey
            ? { authorization: `Bearer ${opts.host.config.escalation.vekinbox.apiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
      let requestId: string | undefined;
      try {
        const json = (await res.json()) as { id?: string };
        requestId = json.id;
      } catch {
        requestId = undefined;
      }
      stored.vekinbox_request_id = requestId;
      await appendChained(
        opts.ledger,
        opts.saga_id,
        "escalation_raised",
        {
          reason_code: opts.reason_code,
          ...(requestId ? { vekinbox_request_id: requestId } : {}),
          approval_binds_to,
          priority,
          escalation_id,
          key,
        } as unknown as JsonValue,
        opts.host,
        opts.effect_id,
      );
    } catch {
      await sinkRaise({
        ledger: opts.ledger,
        host: opts.host,
        saga_id: opts.saga_id,
        effect_id: opts.effect_id,
        reason_code: opts.reason_code,
        approval_binds_to,
        priority,
      });
    }
  } else {
    await sinkRaise({
      ledger: opts.ledger,
      host: opts.host,
      saga_id: opts.saga_id,
      effect_id: opts.effect_id,
      reason_code: opts.reason_code,
      approval_binds_to,
      priority,
    });
  }

  store.set(key, stored);
  byEscalationId.set(escalation_id, stored);
  return { escalation_id, key, payload };
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  nowMs: number = Date.now(),
): boolean {
  if (!secret || !timestamp || !signature) return false;
  const tsSec = Number(timestamp);
  if (!Number.isFinite(tsSec)) return false;
  const tsMs = tsSec * 1000;
  if (Math.abs(nowMs - tsMs) > WEBHOOK_MAX_TIMESTAMP_SKEW_MS) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface OnResumeResult {
  ok: boolean;
  error_code?: string;
  executed?: boolean;
}

export async function onResume(
  headers: Record<string, string>,
  rawBody: string,
  opts: { host: EffectHost; ledger?: Ledger; now?: number; execute?: typeof executePlan },
): Promise<OnResumeResult> {
  const sig =
    headers["x-vekinbox-signature"] ??
    headers["X-VekInbox-Signature"] ??
    headers["x-vekinbox-signature".toLowerCase()];
  const timestamp = headers["x-vekinbox-timestamp"] ?? headers["X-VekInbox-Timestamp"] ?? "";
  const secret = webhookSecret(opts.host);
  if (!verifyWebhookSignature(secret, String(timestamp), rawBody, String(sig ?? ""), opts.now)) {
    console.error("VR6003 bad_signature");
    return { ok: false, error_code: "VR6003" };
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    console.error("VR6003 bad_signature");
    return { ok: false, error_code: "VR6003" };
  }

  const action = String(body.action ?? body.type ?? "approve_compensation");
  const key = String(body.key ?? body.escalation_id ?? "");
  const stored = getStoredEscalation(key);
  if (!stored) {
    console.error("VR6003 bad_signature");
    return { ok: false, error_code: "VR6003" };
  }

  const ledger = opts.ledger ?? opts.host.ledgerHandle;
  if (!ledger) throw new VekRevertError("VR2002", "ledger not open");

  const actorId = String(body.actor_id ?? body.resolved_by ?? "human");

  if (action === "mark_manually_resolved") {
    const row = await ledger.getEffect(stored.effect_id);
    if (row) {
      row.compensation_state = "manually_resolved";
      await ledger.upsertEffect(row);
    }
    await appendChained(
      ledger,
      stored.saga_id,
      "escalation_resolved",
      {
        action: "mark_manually_resolved",
        resolved_by: actorId,
        plan_hash: stored.payload.approval_binds_to,
        executed: false,
      } as unknown as JsonValue,
      opts.host,
      stored.effect_id,
    );
    return { ok: true, executed: false };
  }

  if (action === "decline") {
    await appendChained(
      ledger,
      stored.saga_id,
      "escalation_resolved",
      {
        action: "decline",
        resolved_by: actorId,
        plan_hash: stored.payload.approval_binds_to,
        executed: false,
      } as unknown as JsonValue,
      opts.host,
      stored.effect_id,
    );
    return { ok: false, error_code: "VR6006", executed: false };
  }

  if (!stored.plan) {
    return { ok: false, error_code: "VR3001" };
  }

  const recomputed = planHash({
    effect_id: stored.plan.effect_id,
    compensator_id: stored.plan.compensator_id,
    origin: stored.plan.origin,
    steps: stored.plan.steps,
  });
  const claimed = String(body.plan_hash ?? stored.payload.approval_binds_to);
  if (recomputed !== stored.payload.approval_binds_to || claimed !== stored.payload.approval_binds_to) {
    await raise({
      ledger,
      host: opts.host,
      saga_id: stored.saga_id,
      effect_id: stored.effect_id,
      reason_code: stored.payload.reason_code,
      plan: stored.plan,
      receipt: stored.receipt,
      signature: stored.signature,
    });
    const err = new VekRevertError("VR6004", "plan_hash_mismatch");
    throw err;
  }

  const prov = assertProvenance(stored.plan.steps);
  if (prov) throw new VekRevertError(prov.error_code, prov.detail);

  const resolved: JsonValue[] = [];
  if (stored.signature) {
    for (const step of stored.plan.steps) {
      resolved.push(resolveDeep(step as unknown as JsonValue, stored.receipt, stored.signature, stored.plan.origin));
    }
    const scope = assertScope(stored.plan.steps, resolved, stored.receipt, stored.signature, stored.plan.origin);
    if (scope) throw new VekRevertError(scope.error_code, scope.detail);
  }

  await appendChained(
    ledger,
    stored.saga_id,
    "approval_granted",
    { plan_hash: stored.plan.plan_hash, actor_id: actorId } as unknown as JsonValue,
    opts.host,
    stored.effect_id,
  );

  await ledger.putPlan(stored.plan);
  const exec = opts.execute ?? executePlan;
  await exec(stored.plan, {
    ledger,
    host: opts.host,
    actor: { kind: "human", id: actorId },
  });

  await appendChained(
    ledger,
    stored.saga_id,
    "escalation_resolved",
    {
      action: "approve_compensation",
      resolved_by: actorId,
      plan_hash: stored.plan.plan_hash,
      executed: true,
    } as unknown as JsonValue,
    opts.host,
    stored.effect_id,
  );

  return { ok: true, executed: true };
}

function resolveDeep(
  v: JsonValue,
  receipt: EffectReceipt,
  signature: ActionSignature,
  origin: CompensationPlan["origin"],
): JsonValue {
  if (isRef(v)) {
    const r = resolveRef(v, receipt, signature, origin);
    if (!r.ok) throw new VekRevertError(r.rejection.error_code, r.rejection.detail);
    if (isRef(r.value)) return r.value as unknown as JsonValue;
    return r.value;
  }
  if (Array.isArray(v)) return v.map((x) => resolveDeep(x, receipt, signature, origin));
  if (v && typeof v === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, val] of Object.entries(v)) out[k] = resolveDeep(val as JsonValue, receipt, signature, origin);
    return out;
  }
  return v;
}
