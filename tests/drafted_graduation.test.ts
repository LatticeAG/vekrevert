import { describe, expect, it } from "vitest";
import { compilePlan, isPlanRejection, VekRevertError, type CompensationPlan, type EffectReceipt } from "@latticeag/vekrevert-core";
import {
  draftedActionAllowed,
  draftedSignature,
  executeGateRejection,
  projectionToReceipt,
  STRUCTURAL_VERIFIER_MODEL,
  VekRevert,
} from "../sdk-ts/src/index.ts";
import { receiptsCommand as cliReceipts } from "../packages/cli/src/commands/receipts.ts";
import { doctorCommand } from "../packages/cli/src/commands/doctor.ts";

function failRecord(plan: CompensationPlan) {
  return {
    verdict: "FAIL" as const,
    scope_ok: false,
    sufficiency: "no" as const,
    overreach: true,
    order_ok: true,
    reasons: ["test fail"],
    model: "test",
    prompt_hash: "sha256:fail",
    plan_hash: plan.plan_hash,
    latency_ms: 0,
    verified_at: "1970-01-01T00:00:00.000Z",
  };
}

function passRecord(plan: CompensationPlan) {
  return {
    verdict: "PASS" as const,
    scope_ok: true,
    sufficiency: "full" as const,
    overreach: false,
    order_ok: true,
    reasons: ["test pass"],
    model: STRUCTURAL_VERIFIER_MODEL,
    prompt_hash: "sha256:pass",
    plan_hash: plan.plan_hash,
    latency_ms: 0,
    verified_at: "1970-01-01T00:00:00.000Z",
  };
}

async function unmatchedHttp(v: VekRevert, key: string): Promise<{ sagaId: string; receipt: EffectReceipt }> {
  const saga = await v.openSaga({ key });
  await saga.effect({
    action: {
      kind: "http",
      name: "http.PATCH.api.example.com/v1/widgets",
      target: "api.example.com",
      locality: "external",
    },
    args: { method: "PATCH", url: "https://api.example.com/v1/widgets/w_1", body: { n: 2 } },
    run: async () => ({ status: 200, id: "w_1" }),
  });
  const row = (await v.ledgerHandle!.listEffects(saga.id))[0]!;
  const bindings = { ...(row.bindings as Record<string, unknown>), resource_url: "https://api.example.com/v1/widgets/w_1", id: "w_1" };
  const updated = { ...row, bindings, resource_keys: ["http:api.example.com:/v1/widgets/w_1"] };
  await v.ledgerHandle!.upsertEffect(updated);
  return { sagaId: saga.id, receipt: projectionToReceipt(updated) };
}

describe("drafted graduation", () => {
  it("allowlist: fs.* admits fs, http still VR4005", () => {
    const cfg = { ledger: "memory", allowDrafted: true, drafted: { allow: ["fs.*"], requireGate: true } };
    expect(draftedActionAllowed({ kind: "fs", name: "fs.write./tmp/a" }, cfg)).toBe(true);
    expect(draftedActionAllowed({ kind: "http", name: "http.POST.api.example.com/x" }, cfg)).toBe(false);
    expect(draftedActionAllowed({ kind: "mcp_tool", name: "chat.postMessage" }, { ...cfg, drafted: { allow: ["message.*"] } })).toBe(
      true,
    );
  });

  it("allowlist enforcement on plan() is VR4005; VR3010 unchanged", async () => {
    const v = new VekRevert({
      ledger: "memory",
      allowDrafted: true,
      drafted: { allow: ["fs.*"], requireGate: true },
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const { receipt } = await unmatchedHttp(v, `draft-allow-${Math.random()}`);
    const out = await v.plan(receipt.effect_id, { allowDrafted: true });
    expect(out).toMatchObject({ ok: false, error_code: "VR4005" });

    const steps = [
      {
        kind: "http_request" as const,
        method: "DELETE" as const,
        url: { $ref: "const.base" as const },
        expect: { status_in: [200] },
      },
    ];
    const compiled = compilePlan(receipt, draftedSignature(receipt, steps), { origin: "drafted", steps });
    expect(isPlanRejection(compiled)).toBe(true);
    if (isPlanRejection(compiled)) expect(compiled.error_code).toBe("VR3010");
  });

  it("gate coupling: audit escalates, enforce rejects via PlanRejection codes", async () => {
    const mk = async (mode: "audit" | "enforce") => {
      const v = new VekRevert({
        ledger: "memory",
        allowDrafted: true,
        verification: { mode },
        drafted: { allow: ["http.*"], requireGate: true },
        ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
      });
      const { receipt } = await unmatchedHttp(v, `draft-gate-${mode}-${Math.random()}`);
      const steps = [
        {
          kind: "http_request" as const,
          method: "DELETE" as const,
          url: { $ref: "receipt.bindings.resource_url" as const },
          expect: { status_in: [200, 202, 204, 404], treat_404_as_compensated: true },
        },
      ];
      const plan = compilePlan(receipt, draftedSignature(receipt, steps), {
        origin: "drafted",
        steps,
        plan_id: `cpl_draft_${mode}`,
      });
      if (isPlanRejection(plan)) throw new Error(plan.detail);
      plan.verification = failRecord(plan);
      await v.ledgerHandle!.putPlan(plan);
      v.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
      return { v, plan };
    };

    const audit = await mk("audit");
    expect(executeGateRejection(audit.plan, "audit")).toMatchObject({ ok: false });
    const auditOut = await audit.v.execute(audit.plan.plan_id, { dryRun: true });
    expect(auditOut.ok).toBe(false);
    expect(auditOut.error_code?.startsWith("VR4")).toBe(true);

    const enforce = await mk("enforce");
    await expect(enforce.v.execute(enforce.plan.plan_id, { dryRun: true })).rejects.toSatisfy(
      (err: unknown) => err instanceof VekRevertError && String(err.code).startsWith("VR4"),
    );
  });

  it("provenance origin=drafted is visible in receipts report and CLI output", async () => {
    const v = new VekRevert({
      ledger: "memory",
      allowDrafted: true,
      drafted: { allow: ["http.*"], requireGate: true },
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: `draft-orig-${Math.random()}` });
    await saga.effect({
      action: {
        kind: "http",
        name: "http.POST.api.example.com/v1/widgets",
        target: "api.example.com",
        locality: "external",
      },
      args: { method: "POST", url: "https://api.example.com/v1/widgets", body: { n: 1 } },
      run: async () => ({
        status: 201,
        headers: { Location: "https://api.example.com/v1/widgets/w_1" },
        id: "w_1",
      }),
    });
    const row = (await v.ledgerHandle!.listEffects(saga.id))[0]!;
    const receipt = projectionToReceipt(row);
    const steps = [
      {
        kind: "http_request" as const,
        method: "DELETE" as const,
        url: { $ref: "receipt.bindings.resource_url" as const },
        expect: { status_in: [200, 202, 204, 404], treat_404_as_compensated: true },
      },
    ];
    const plan = compilePlan(receipt, draftedSignature(receipt, steps), {
      origin: "drafted",
      steps,
      plan_id: "cpl_orig",
    });
    if (isPlanRejection(plan)) throw new Error(plan.detail);
    plan.verification = passRecord(plan);
    await v.ledgerHandle!.putPlan(plan);
    v.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const executed = await v.execute(plan.plan_id);
    expect(executed.ok).toBe(true);
    const report = await v.receipts(saga.id);
    const blob = JSON.stringify(report);
    expect(blob).toContain('"origin":"drafted"');
    expect(report.origins?.some((o) => o.origin === "drafted")).toBe(true);

    const chunks: string[] = [];
    await cliReceipts([saga.id], {
      ledger: v.ledgerHandle!,
      stdout: { write: (c: string) => void chunks.push(c) },
      stderr: { write: () => undefined },
    });
    expect(chunks.join("")).toContain("drafted");
  });

  it("doctor reports drafted policy and coordinator reachability", async () => {
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
      checks: Array<{ name: string; detail: string }>;
    };
    const names = parsed.checks.map((c) => c.name);
    expect(names).toContain("verification");
    expect(names).toContain("drafted");
    expect(names).toContain("coordinator");
    expect(parsed.checks.find((c) => c.name === "drafted")!.detail).toMatch(/allowDrafted=/);
    expect(parsed.checks.find((c) => c.name === "coordinator")!.detail).toMatch(/not configured|reachable|unreachable/);
  });
});
