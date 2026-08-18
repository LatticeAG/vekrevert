import { describe, expect, it } from "vitest";
import { compilePlan, isPlanRejection, type CompensationStep, type EffectReceipt } from "@latticeag/vekrevert-core";
import {
  draftedSignature,
  evaluateFourQuestions,
  skipVerifierRecord,
  verificationPassesGate,
  verifyPlan,
} from "../sdk-ts/src/index.ts";

function httpCreate(): EffectReceipt {
  return {
    v: "vekrevert/v1",
    effect_id: "eff_v1",
    saga_id: "sag_v1",
    seq: 1,
    action: { kind: "http", name: "http.POST.api.example.com/v1/invoices", locality: "external" },
    tier: "T3",
    classification: { tier: "T3", sources: [], reasons: [], candidates: [], scope_violation: false },
    args_observed: { method: "POST", url: "https://api.example.com/v1/invoices" },
    args_hash: "sha256:v",
    intent_key: "sha256:v",
    result_observed: { status: 201, id: "inv_1" },
    bindings: { resource_url: "https://api.example.com/v1/invoices/inv_1", id: "inv_1" },
    binding_paths: {},
    resource_keys: ["http:api.example.com:/v1/invoices/inv_1"],
    status: "landed",
    compensation_state: "available",
    capture: { fidelity: "full", interceptor: "test", sdk_version: "0.1.0", warnings: [] },
    leak: "none",
    cascade_risk: "none",
    opened_at: "1970-01-01T00:00:00.000Z",
    redactions: [],
    sealed: true,
  };
}

function compile(receipt: EffectReceipt, steps: CompensationStep[]) {
  const sig = draftedSignature(receipt, steps);
  return compilePlan(receipt, sig, { origin: "drafted", steps, plan_id: "cpl_v" });
}

describe("phase8 verifier", () => {
  it("four questions PASS a clean inverse DELETE", async () => {
    const receipt = httpCreate();
    const compiled = compile(receipt, [
      {
        kind: "http_request",
        method: "DELETE",
        url: { $ref: "receipt.bindings.resource_url" },
        expect: { status_in: [200, 202, 204, 404], treat_404_as_compensated: true },
      },
    ]);
    expect(isPlanRejection(compiled)).toBe(false);
    if (isPlanRejection(compiled)) return;
    const rec = await verifyPlan(compiled, receipt);
    expect(rec.plan_hash).toBe(compiled.plan_hash);
    expect(rec.verdict).toBe("PASS");
    expect(rec.scope_ok).toBe(true);
    expect(rec.overreach).toBe(false);
    expect(rec.sufficiency).toBe("full");
    expect(rec.order_ok).toBe(true);
    expect(verificationPassesGate(rec)).toBe(true);
    expect(rec.model).not.toBe(rec.drafter_model ?? "vekrevert-drafter-heuristic");
  });

  it("caches by plan_hash", async () => {
    const receipt = httpCreate();
    const compiled = compile(receipt, [
      {
        kind: "http_request",
        method: "DELETE",
        url: { $ref: "receipt.bindings.resource_url" },
        expect: { status_in: [200, 204, 404], treat_404_as_compensated: true },
      },
    ]);
    if (isPlanRejection(compiled)) throw new Error(compiled.detail);
    const a = await verifyPlan(compiled, receipt);
    const b = await verifyPlan(compiled, receipt);
    expect(a.verified_at).toBe(b.verified_at);
    expect(a.prompt_hash).toBe(b.prompt_hash);
  });

  it("treat_404 on a PATCH is overreach FAIL", async () => {
    const receipt = httpCreate();
    receipt.action = { kind: "http", name: "http.PATCH.api.example.com/v1/invoices", locality: "external" };
    receipt.args_observed = { method: "PATCH", url: "https://api.example.com/v1/invoices/inv_1" };
    const compiled = compile(receipt, [
      {
        kind: "http_request",
        method: "DELETE",
        url: { $ref: "receipt.bindings.resource_url" },
        expect: { status_in: [200, 404], treat_404_as_compensated: true },
      },
    ]);
    if (isPlanRejection(compiled)) throw new Error(compiled.detail);
    const rec = await verifyPlan(compiled, receipt);
    expect(rec.overreach).toBe(true);
    expect(rec.verdict).toBe("FAIL");
  });

  it("builtins skip the verifier", () => {
    const rec = skipVerifierRecord({
      v: "vekrevert/v1",
      plan_id: "cpl_b",
      effect_id: "eff",
      saga_id: "sag",
      compensator_id: "cmp_http_create@1",
      origin: "builtin",
      steps: [],
      plan_hash: "sha256:builtin",
      postconditions: [],
      reversal_completeness: "full",
      leak: "none",
      cascade_risk: "none",
      summary: "builtin",
      created_at: "1970-01-01T00:00:00.000Z",
    });
    expect(rec.model).toBe("builtin-skip");
    expect(rec.verdict).toBe("PASS");
  });

  it("evaluateFourQuestions flags extra cleanup as overreach", () => {
    const receipt = httpCreate();
    receipt.resource_keys.push("http:api.example.com:/v1/webhooks/wh_1");
    receipt.bindings.cleanup_url = "https://api.example.com/v1/webhooks/wh_1";
    const compiled = compile(receipt, [
      {
        kind: "http_request",
        method: "DELETE",
        url: { $ref: "receipt.bindings.resource_url" },
        expect: { status_in: [200, 204] },
      },
      {
        kind: "http_request",
        method: "DELETE",
        url: { $ref: "receipt.bindings.cleanup_url" },
        expect: { status_in: [200, 204] },
      },
    ]);
    if (isPlanRejection(compiled)) throw new Error(compiled.detail);
    const a = evaluateFourQuestions(compiled, receipt, compiled.steps as unknown as never[]);
    expect(a.overreach).toBe(true);
  });
});
