import { describe, expect, it } from "vitest";
import { isPlanRejection } from "@latticeag/vekrevert-core";
import { VekRevert } from "../sdk-ts/src/index.ts";
import { runCli } from "../packages/cli/src/index.ts";

describe("phase8 pipeline", () => {
  it("plan({allowDrafted:true}) is VR4005 when workspace has not opted in", async () => {
    const v = new VekRevert({ ledger: "memory", ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 } });
    const out = await v.plan("eff_missing", { allowDrafted: true });
    expect(out).toMatchObject({ ok: false, error_code: "VR4005" });
  });

  it("plan without a match and without allowDrafted is VR3001", async () => {
    const v = new VekRevert({ ledger: "memory", ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 } });
    const saga = await v.openSaga({ key: "p8-nomatch" });
    await saga.effect({
      action: { kind: "sdk_fn", name: "unknown.custom", locality: "unknown" },
      args: { x: 1 },
      run: async () => ({ ok: true }),
    });
    const id = (await v.ledgerHandle!.listEffects(saga.id))[0]!.effect_id;
    const out = await v.plan(id);
    expect(out).toMatchObject({ ok: false, error_code: "VR3001" });
  });

  it("T4 + drafted is refused", async () => {
    const v = new VekRevert({
      ledger: "memory",
      allowDrafted: true,
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "p8-t4" });
    await saga.effect({
      action: { kind: "shell", name: "shell.rm", target: "rm", locality: "unknown" },
      args: { argv0: "rm", argv: ["-rf", "/tmp/x"] },
      run: async () => "ok",
    });
    const id = (await v.ledgerHandle!.listEffects(saga.id))[0]!.effect_id;
    const out = await v.plan(id, { allowDrafted: true });
    expect(out).toMatchObject({ ok: false, error_code: "VR4005" });
  });

  it("drafted const.* is VR3010", async () => {
    const { compilePlan, isPlanRejection } = await import("@latticeag/vekrevert-core");
    const { draftedSignature } = await import("../sdk-ts/src/index.ts");
    const receipt = {
      v: "vekrevert/v1" as const,
      effect_id: "eff_c",
      saga_id: "sag_c",
      seq: 1,
      action: { kind: "http" as const, name: "http.POST.x/y", locality: "external" as const },
      tier: "T3" as const,
      classification: { tier: "T3" as const, sources: [], reasons: [], candidates: [], scope_violation: false },
      args_observed: { method: "POST", url: "https://x/y" },
      args_hash: "sha256:c",
      intent_key: "sha256:c",
      bindings: { resource_url: "https://x/y/1" },
      binding_paths: {},
      resource_keys: ["http:x:/y/1"],
      status: "landed" as const,
      compensation_state: "available" as const,
      capture: { fidelity: "full" as const, interceptor: "t", sdk_version: "0.1.0", warnings: [] },
      leak: "none" as const,
      cascade_risk: "none" as const,
      opened_at: "1970-01-01T00:00:00.000Z",
      redactions: [],
      sealed: true,
    };
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

  it("allowDrafted defaults false on the SDK", () => {
    const v = new VekRevert({ ledger: "memory" });
    expect(v.config.allowDrafted).toBe(false);
  });

  it("vekrevert plan --allow-drafted exits 4 when workspace has not opted in", async () => {
    const code = await runCli(["plan", "eff_unknown_phase8", "--allow-drafted", "--json"]);
    expect(code).toBe(4);
    expect(code).not.toBe(1);
  });
});

void isPlanRejection;
