/** vekrevert plan <effect-id> [--json] [--out] and --action-json <file> */

import { readFileSync, writeFileSync } from "node:fs";
import {
  compilePlan,
  isPlanRejection,
  isRef,
  matchCompensator,
  resolveRef,
  resourceKeys,
  type ActionRef,
  type ActionSignature,
  type ArgValue,
  type CompensationPlan,
  type CompensationStep,
  type EffectReceipt,
  type JsonValue,
} from "@latticeag/vekrevert-core";
import { CompensatorRegistry } from "@latticeag/vekrevert/registry";
import type { Ledger } from "@latticeag/vekrevert";

type EffectProjection = NonNullable<Awaited<ReturnType<Ledger["getEffect"]>>>;

export async function planCommand(argv: string[], ctx?: { ledger?: Ledger }): Promise<number> {
  if (argv.includes("--allow-drafted")) {
    process.stderr.write("VR4005 drafted_not_allowed\n");
    return 4;
  }

  let actionJson: string | undefined;
  let effectId: string | undefined;
  let json = false;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--action-json") actionJson = argv[++i];
    else if (a.startsWith("--action-json=")) actionJson = a.slice("--action-json=".length);
    else if (a === "--json") json = true;
    else if (a === "--out") out = argv[++i];
    else if (a.startsWith("--out=")) out = a.slice("--out=".length);
    else if (a.startsWith("-")) {
      process.stderr.write(`unknown flag ${a}\n`);
      return 2;
    } else if (!effectId) effectId = a;
  }

  if (!actionJson && !effectId) {
    process.stderr.write("usage: vekrevert plan <effect-id> [--json] [--out file]\n       vekrevert plan --action-json <file> [--json] [--out file]\n");
    return 2;
  }

  let receipt: EffectReceipt;
  let signature: ActionSignature | undefined;

  if (actionJson) {
    const raw = JSON.parse(readFileSync(actionJson, "utf8")) as Record<string, unknown>;
    const built = receiptFromActionJson(raw);
    receipt = built.receipt;
    signature = built.signature;
  } else {
    if (!ctx?.ledger) {
      process.stderr.write("VR3001 no_compensator_match: ledger required for effect-id\n");
      return 3;
    }
    const proj = await ctx.ledger.getEffect(effectId!);
    if (!proj) {
      process.stderr.write(`VR3001 no_compensator_match: unknown effect ${effectId}\n`);
      return 3;
    }
    receipt = projectionToReceipt(proj);
  }

  if (!signature) {
    const registry = new CompensatorRegistry({ ledger: ctx?.ledger });
    await registry.hydrate();
    const listed = await registry.list();
    const matched = matchCompensator(listed, receipt.action, receipt.args_observed, receipt.result_observed);
    signature = matched.matched ?? undefined;
  }

  if (!signature) {
    process.stderr.write("VR3001 no_compensator_match\n");
    return 3;
  }

  const compiled = compilePlan(receipt, signature);
  if (isPlanRejection(compiled)) {
    process.stderr.write(`${compiled.error_code} ${compiled.detail}\n`);
    return 3;
  }

  const resolved = resolvePlan(compiled, receipt, signature);
  const payload = json || out ? { ...compiled, resolved } : compiled;
  const text = JSON.stringify(payload, null, 2) + "\n";
  if (out) writeFileSync(out, text);
  else process.stdout.write(json || actionJson ? text : `${compiled.plan_id} ${compiled.plan_hash} ${compiled.summary}\n`);
  if (!json && !out && !actionJson) {
    process.stdout.write(JSON.stringify(resolved, null, 2) + "\n");
  }
  return 0;
}

export function receiptFromActionJson(raw: Record<string, unknown>): { receipt: EffectReceipt; signature?: ActionSignature } {
  if (raw.v === "vekrevert/v1" && raw.effect_id && raw.action) {
    return { receipt: raw as unknown as EffectReceipt, signature: raw.signature as ActionSignature | undefined };
  }
  const nested = raw.receipt as Record<string, unknown> | undefined;
  const action = (raw.action ?? nested?.action) as ActionRef;
  const args = (raw.args ?? {}) as JsonValue;
  const result = (raw.result ?? raw.result_observed) as JsonValue | undefined;
  const headers = (raw.headers ?? {}) as Record<string, string>;
  const bindings = (raw.bindings ?? {}) as Record<string, JsonValue>;
  const signature = raw.signature as ActionSignature | undefined;
  const keys =
    (raw.resource_keys as string[] | undefined) ??
    resourceKeys({ action, bindings, args, result, headers });
  const receipt: EffectReceipt = {
    v: "vekrevert/v1",
    effect_id: String(raw.effect_id ?? "eff_action_json"),
    saga_id: String(raw.saga_id ?? "sag_action_json"),
    seq: Number(raw.seq ?? 1),
    action,
    tier: (raw.tier as EffectReceipt["tier"]) ?? signature?.tier ?? "T3",
    classification: {
      tier: (raw.tier as EffectReceipt["tier"]) ?? "T3",
      sources: [],
      reasons: [],
      candidates: [],
      scope_violation: false,
    },
    args_observed: args,
    args_hash: String(raw.args_hash ?? "sha256:action-json"),
    intent_key: String(raw.intent_key ?? "sha256:action-json"),
    result_observed: result,
    bindings,
    binding_paths: (raw.binding_paths as Record<string, string>) ?? {},
    resource_keys: keys,
    status: "landed",
    compensation_state: "available",
    capture: { fidelity: "full", interceptor: "action-json", sdk_version: "0.1.0", warnings: [] },
    leak: signature?.leak ?? "none",
    cascade_risk: signature?.cascade_risk ?? "none",
    opened_at: "1970-01-01T00:00:00.000Z",
    redactions: [],
    sealed: true,
    preimage: raw.preimage as EffectReceipt["preimage"],
  };
  return { receipt, signature };
}

function projectionToReceipt(p: EffectProjection): EffectReceipt {
  return {
    v: "vekrevert/v1",
    effect_id: p.effect_id,
    saga_id: p.saga_id,
    seq: p.seq,
    compensation_of: p.compensation_of,
    restore_sibling_of: p.restore_sibling_of,
    parent_effect_id: p.parent_effect_id,
    action: {
      kind: p.action_kind as ActionRef["kind"],
      name: p.action_name,
      target: p.action_target,
      locality: p.locality as ActionRef["locality"],
    },
    tier: p.tier as EffectReceipt["tier"],
    classification: (p.classification as unknown as EffectReceipt["classification"]) ?? {
      tier: p.tier as EffectReceipt["tier"],
      sources: [],
      reasons: [],
      candidates: [],
      scope_violation: false,
    },
    args_observed: p.args_observed,
    args_hash: p.args_hash,
    intent_key: p.intent_key,
    result_observed: p.result_observed,
    bindings: (p.bindings as Record<string, JsonValue>) ?? {},
    binding_paths: (p.binding_paths as Record<string, string>) ?? {},
    resource_keys: Array.isArray(p.resource_keys) ? (p.resource_keys as string[]) : [],
    status: p.status as EffectReceipt["status"],
    compensation_state: p.compensation_state as EffectReceipt["compensation_state"],
    compensator_id: p.compensator_id,
    capture: {
      fidelity: p.capture_fidelity as EffectReceipt["capture"]["fidelity"],
      interceptor: p.capture_interceptor,
      sdk_version: "0.1.0",
      warnings: [],
    },
    leak: p.leak as EffectReceipt["leak"],
    cascade_risk: p.cascade_risk as EffectReceipt["cascade_risk"],
    opened_at: p.opened_at,
    closed_at: p.closed_at,
    redactions: [],
    sealed: p.sealed === 1,
    seal_hash: p.seal_hash,
    preimage: p.preimage_kind
      ? {
          kind: p.preimage_kind as NonNullable<EffectReceipt["preimage"]>["kind"],
          blob_id: p.preimage_blob_id,
          bytes: p.preimage_bytes,
          rows: p.preimage_rows,
          truncated: p.preimage_truncated === 1,
          meta: p.preimage_meta as Record<string, string | number> | undefined,
        }
      : undefined,
  };
}

function resolvePlan(plan: CompensationPlan, receipt: EffectReceipt, signature: ActionSignature): JsonValue {
  return plan.steps.map((step) => resolveDeep(step as unknown as JsonValue, receipt, signature)) as unknown as JsonValue;
}

function resolveDeep(v: JsonValue, receipt: EffectReceipt, signature: ActionSignature): JsonValue {
  if (isRef(v)) {
    const r = resolveRef(v, receipt, signature, signature.source);
    if (!r.ok) return { $ref: v.$ref, error: r.rejection.detail } as unknown as JsonValue;
    if (isRef(r.value)) return r.value as unknown as JsonValue;
    return r.value;
  }
  if (Array.isArray(v)) return v.map((x) => resolveDeep(x, receipt, signature));
  if (v && typeof v === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, val] of Object.entries(v)) out[k] = resolveDeep(val as JsonValue, receipt, signature);
    return out;
  }
  return v;
}

void 0 as unknown as ArgValue;
void 0 as unknown as CompensationStep;
