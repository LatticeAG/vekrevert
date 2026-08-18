import { describe, expect, it } from "vitest";
import {
  draftCompensation,
  shapesFromReceipt,
  redactToShape,
  heuristicDraft,
  type EffectReceipt,
} from "../sdk-ts/src/index.ts";

function httpReceipt(): EffectReceipt {
  return {
    v: "vekrevert/v1",
    effect_id: "eff_d1",
    saga_id: "sag_d1",
    seq: 1,
    action: { kind: "http", name: "http.POST.api.example.com/v1/widgets", locality: "external" },
    tier: "T3",
    classification: { tier: "T3", sources: [], reasons: [], candidates: [], scope_violation: false },
    args_observed: { method: "POST", url: "https://api.example.com/v1/widgets", body: { secret: "sk_live_SHOULDNOTSEE" } },
    args_hash: "sha256:d",
    intent_key: "sha256:d",
    result_observed: { status: 201, id: "w_1" },
    bindings: { resource_url: "https://api.example.com/v1/widgets/w_1", id: "w_1" },
    binding_paths: {},
    resource_keys: ["http:api.example.com:/v1/widgets/w_1"],
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

describe("phase8 drafter", () => {
  it("redacts values to type names", () => {
    expect(redactToShape({ id: "inv_7f3a91", n: 3, ok: true, nested: { token: "abc" } })).toEqual({
      id: "string",
      n: "number",
      ok: "boolean",
      nested: { token: "string" },
    });
  });

  it("shapesFromReceipt never includes resource identifiers or values", () => {
    const view = shapesFromReceipt(httpReceipt());
    const blob = JSON.stringify(view);
    expect(blob).not.toContain("sk_live_SHOULDNOTSEE");
    expect(blob).not.toContain("w_1");
    expect(blob).not.toContain("api.example.com/v1/widgets/w_1");
    expect(view.binding_names).toEqual(["id", "resource_url"]);
    expect(view.arg_shapes).toMatchObject({ method: "string", url: "string" });
  });

  it("heuristic draft emits refs only", () => {
    const view = shapesFromReceipt(httpReceipt());
    const steps = heuristicDraft(view);
    expect(Array.isArray(steps)).toBe(true);
    expect(JSON.stringify(steps)).toContain('"$ref":"receipt.bindings.resource_url"');
    expect(JSON.stringify(steps)).not.toContain("w_1");
  });

  it("T4 is refused", async () => {
    const r = httpReceipt();
    r.tier = "T4";
    const out = await draftCompensation(r);
    expect(out).toMatchObject({ ok: false, error_code: "VR4005" });
  });

  it("complete seam receives shapes only", async () => {
    const seen: string[] = [];
    await draftCompensation(httpReceipt(), {
      complete: (view) => {
        seen.push(JSON.stringify(view));
        return heuristicDraft(view) as never;
      },
    });
    expect(seen.join("")).not.toContain("sk_live_SHOULDNOTSEE");
    expect(seen.join("")).not.toContain("w_1");
  });
});
