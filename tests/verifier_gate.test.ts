import { afterEach, describe, expect, it } from "vitest";
import {
  compilePlan,
  isPlanRejection,
  VekRevertError,
  type CompensationPlan,
  type EffectReceipt,
  type VerificationRecord,
} from "@latticeag/vekrevert-core";
import { httpCreate } from "@latticeag/vekrevert-compensators";
import {
  doctorCommand,
} from "../packages/cli/src/commands/doctor.ts";
import {
  draftedSignature,
  executeGateRejection,
  projectionToReceipt,
  recordToRejection,
  resolveVerificationPolicy,
  STRUCTURAL_VERIFIER_MODEL,
  verificationPassesGate,
  verifyPlan,
  VekRevert,
} from "../sdk-ts/src/index.ts";

function failRecord(plan: CompensationPlan, over: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    verdict: "FAIL",
    scope_ok: false,
    sufficiency: "no",
    overreach: true,
    order_ok: true,
    reasons: ["test fail"],
    model: "test",
    prompt_hash: "sha256:fail",
    plan_hash: plan.plan_hash,
    latency_ms: 0,
    verified_at: "1970-01-01T00:00:00.000Z",
    ...over,
  };
}

function httpCreateReceipt(): EffectReceipt {
  return {
    v: "vekrevert/v1",
    effect_id: "eff_gate",
    saga_id: "sag_gate",
    seq: 1,
    action: { kind: "http", name: "http.POST.api.example.com/v1/invoices", locality: "external" },
    tier: "T3",
    classification: { tier: "T3", sources: [], reasons: [], candidates: [], scope_violation: false },
    args_observed: { method: "POST", url: "https://api.example.com/v1/invoices" },
    args_hash: "sha256:g",
    intent_key: "sha256:g",
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

function compileDrafted(receipt: EffectReceipt) {
  const steps = [
    {
      kind: "http_request" as const,
      method: "DELETE" as const,
      url: { $ref: "receipt.bindings.resource_url" as const },
      expect: { status_in: [200, 202, 204, 404], treat_404_as_compensated: true },
    },
  ];
  const compiled = compilePlan(receipt, draftedSignature(receipt, steps), {
    origin: "drafted",
    steps,
    plan_id: "cpl_gate",
  });
  if (isPlanRejection(compiled)) throw new Error(compiled.detail);
  return compiled;
}

async function landedHttpEffect(v: VekRevert, key: string) {
  const saga = await v.openSaga({ key });
  await saga.effect({
    action: {
      kind: "http",
      name: "http.POST.api.example.com/v1/invoices",
      target: "api.example.com",
      locality: "external",
    },
    args: { method: "POST", url: "https://api.example.com/v1/invoices", body: { n: 1 } },
    run: async () => ({
      status: 201,
      headers: { Location: "https://api.example.com/v1/invoices/inv_gate" },
      id: "inv_gate",
    }),
  });
  const row = (await v.ledgerHandle!.listEffects(saga.id))[0]!;
  return { saga, receipt: projectionToReceipt(row) };
}

describe("verifier gate", () => {
  const prevMode = process.env.VEKREVERT_VERIFICATION_MODE;
  afterEach(() => {
    if (prevMode == null) delete process.env.VEKREVERT_VERIFICATION_MODE;
    else process.env.VEKREVERT_VERIFICATION_MODE = prevMode;
  });

  it("defaults to audit", () => {
    const policy = resolveVerificationPolicy({});
    expect(policy.mode).toBe("audit");
  });

  it("VEKREVERT_VERIFICATION_MODE overrides config", () => {
    const policy = resolveVerificationPolicy(
      { verification: { mode: "audit" } },
      { VEKREVERT_VERIFICATION_MODE: "enforce" } as NodeJS.ProcessEnv,
    );
    expect(policy.mode).toBe("enforce");
  });

  it("audit vs enforce: failing registered plan blocks only in enforce", async () => {
    const mk = async (mode: "audit" | "enforce") => {
      const v = new VekRevert({
        ledger: "memory",
        verification: { mode },
        ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
      });
      const { receipt } = await landedHttpEffect(v, `gate-${mode}-${Math.random()}`);
      const plan = compilePlan(receipt, httpCreate, { origin: "registered" });
      if (isPlanRejection(plan)) throw new Error(plan.detail);
      plan.verification = failRecord(plan);
      await v.ledgerHandle!.putPlan(plan);
      return { v, plan };
    };

    const audit = await mk("audit");
    const auditRej = executeGateRejection(audit.plan, "audit");
    expect(auditRej).toBeUndefined();
    const auditOut = await audit.v.execute(audit.plan.plan_id, { dryRun: true });
    expect(auditOut.ok).toBe(true);

    const enforce = await mk("enforce");
    const enforceRej = executeGateRejection(enforce.plan, "enforce");
    expect(enforceRej).toMatchObject({ ok: false });
    expect(enforceRej).toEqual(recordToRejection(enforce.plan.verification!));
    await expect(enforce.v.execute(enforce.plan.plan_id, { dryRun: true })).rejects.toSatisfy(
      (err: unknown) => err instanceof VekRevertError && err.code === enforceRej!.error_code,
    );
  });

  it("offline fallback is capped at uncertain and names the structural model", async () => {
    const receipt = httpCreateReceipt();
    const compiled = compileDrafted(receipt);
    const rec = await verifyPlan(compiled, receipt, {
      model: "grok-4-fast",
      apiKey: "vr_test",
      cache: new Map(),
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(rec.model).toBe(STRUCTURAL_VERIFIER_MODEL);
    expect(rec.verdict).toBe("UNSURE");
    expect(rec.fallback_reason).toBe("model_unreachable");
    expect(rec.reasons.some((r) => /fallback|unreachable|verifier_error/i.test(r))).toBe(true);
    expect(verificationPassesGate(rec)).toBe(false);
    expect(recordToRejection(rec).error_code).toBe("VR4002");
    expect(executeGateRejection({ ...compiled, verification: rec }, "enforce")).toEqual(recordToRejection(rec));
  });

  it("cache hit reuses the plan-hash record within TTL", async () => {
    const receipt = httpCreateReceipt();
    const compiled = compileDrafted(receipt);
    const cache = new Map<string, VerificationRecord>();
    const t0 = new Date("2020-01-01T00:00:00.000Z");
    let calls = 0;
    const complete = () => {
      calls += 1;
      return {
        scope_ok: true,
        sufficiency: "full" as const,
        overreach: false,
        order_ok: true,
        reasons: ["model"],
      };
    };
    const a = await verifyPlan(compiled, receipt, {
      cache,
      now: t0,
      cacheTtlMs: 1_000,
      complete,
      model: "test-model",
    });
    const b = await verifyPlan(compiled, receipt, {
      cache,
      now: new Date("2020-01-01T00:00:00.400Z"),
      cacheTtlMs: 1_000,
      complete,
      model: "test-model",
    });
    expect(calls).toBe(1);
    expect(a.verified_at).toBe(b.verified_at);
    expect(a.prompt_hash).toBe(b.prompt_hash);

    const c = await verifyPlan(compiled, receipt, {
      cache,
      now: new Date("2020-01-01T00:00:02.000Z"),
      cacheTtlMs: 1_000,
      complete,
      model: "test-model",
    });
    expect(calls).toBe(2);
    expect(c.verified_at).toBe("2020-01-01T00:00:02.000Z");
  });

  it("budget exhaustion falls back to the structural verifier", async () => {
    const receipt = httpCreateReceipt();
    const aPlan = compileDrafted(receipt);
    const bSteps = [
      {
        kind: "http_request" as const,
        method: "DELETE" as const,
        url: { $ref: "receipt.bindings.resource_url" as const },
        expect: { status_in: [200, 204, 404], treat_404_as_compensated: true },
      },
    ];
    const bPlan = compilePlan(receipt, draftedSignature(receipt, bSteps), {
      origin: "drafted",
      steps: bSteps,
      plan_id: "cpl_gate_b",
    });
    if (isPlanRejection(bPlan)) throw new Error(bPlan.detail);
    expect(aPlan.plan_hash).not.toBe(bPlan.plan_hash);

    let calls = 0;
    const cache = new Map<string, VerificationRecord>();
    const budget = new Map<string, number>();
    const opts = {
      cache,
      budgetPerSaga: 1,
      sagaId: "sag_budget",
      budgetState: budget,
      model: "test-model",
      complete: () => {
        calls += 1;
        return {
          scope_ok: true,
          sufficiency: "full" as const,
          overreach: false,
          order_ok: true,
          reasons: ["model"],
        };
      },
    };
    const first = await verifyPlan(aPlan, receipt, opts);
    expect(first.fallback_reason).toBeUndefined();
    const second = await verifyPlan(bPlan, receipt, opts);
    expect(calls).toBe(1);
    expect(second.model).toBe(STRUCTURAL_VERIFIER_MODEL);
    expect(second.fallback_reason).toBe("budget_exhausted");
    expect(second.verdict).toBe("UNSURE");
    expect(verificationPassesGate(second)).toBe(false);
  });

  it("doctor reports gate mode + model reachability", async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      await doctorCommand(["--json"]);
    } finally {
      process.stdout.write = orig;
    }
    const parsed = JSON.parse(chunks.join("")) as {
      checks: Array<{ n: number; name: string; status: string; detail: string }>;
    };
    const gate = parsed.checks.find((c) => c.name === "verification");
    expect(gate).toBeTruthy();
    expect(gate!.detail).toMatch(/mode (off|audit|enforce)/);
    expect(gate!.detail).toMatch(/model /);
  });
});
