import { describe, expect, it } from "vitest";
import { openEffect, getCompensationContext, VekRevert } from "../sdk-ts/src/index.ts";

describe("no_regress", () => {
  it("undo through a wrapFetch that records effects adds zero newly-compensable rows (D11)", async () => {
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "noregress" });
    await saga.effect({
      action: {
        kind: "http",
        name: "http.POST.api.example.com/items",
        target: "api.example.com",
        locality: "external",
      },
      args: { method: "POST", url: "https://api.example.com/items", body: { id: "1" } },
      run: async () => ({
        status: 201,
        headers: { Location: "https://api.example.com/items/1" },
        id: "1",
      }),
    });
    const before = await v.ledgerHandle!.listEffects(saga.id);
    expect(before).toHaveLength(1);

    let sawAls = false;
    v.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const ctx = getCompensationContext();
      expect(ctx?.attempt_id).toBeTruthy();
      sawAls = true;
      await openEffect(v, saga.id, {
        action: {
          kind: "http",
          name: "http.DELETE.api.example.com/items",
          target: "api.example.com",
          locality: "external",
        },
        args: { method: "DELETE", url: String(input) },
        run: async () => ({ status: 204 }),
      });
      expect(init?.headers && String((init.headers as Record<string, string>)["X-VekRevert-Compensation"] ?? "")).toBeTruthy();
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const report = await v.undo(saga.id);
    expect(report.compensated).toBe(1);
    expect(sawAls).toBe(true);

    const after = await v.ledgerHandle!.listEffects(saga.id);
    const newly = after.filter((e) => e.compensation_state === "available" || e.compensation_state === "planned");
    expect(newly).toHaveLength(0);
    expect(after.filter((e) => e.compensation_state === "available" || e.compensation_state === "planned").length).toBe(0);

    const events = await v.ledgerHandle!.readSaga(saga.id);
    expect(events.some((e) => e.type === "compensation_side_effect")).toBe(true);
    expect(events.some((e) => e.type === "compensation_executed")).toBe(true);
  });
});
