import { describe, expect, it } from "vitest";
import { executePlan, VekRevert } from "../sdk-ts/src/index.ts";
import { isPlanRejection } from "@latticeag/vekrevert-core";

describe("idempotency_race", () => {
  it("32 concurrent execute on one plan make exactly one downstream call", async () => {
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "race" });
    await saga.effect({
      action: {
        kind: "http",
        name: "http.POST.api.example.com/items",
        target: "api.example.com",
        locality: "external",
      },
      args: { method: "POST", url: "https://api.example.com/items", body: { n: 1 } },
      run: async () => ({
        status: 201,
        headers: { Location: "https://api.example.com/items/it_1" },
        id: "it_1",
      }),
    });
    const plan = await v.plan((await v.ledgerHandle!.listEffects(saga.id))[0]!.effect_id);
    if (isPlanRejection(plan)) throw new Error(plan.detail);

    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const workers = Array.from({ length: 32 }, () =>
      executePlan(plan, {
        ledger: v.ledgerHandle!,
        host: v,
        registry: v.registry,
        fetch: fetchMock,
        lease: { ttlMs: 5_000, waitMs: 2_000, heartbeatMs: 1_000, pollMs: 5 },
      }),
    );
    const results = await Promise.all(workers);
    expect(calls).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
