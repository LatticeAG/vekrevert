import { describe, expect, it } from "vitest";
import { VekRevertError } from "@latticeag/vekrevert-core";
import { openEffect, VekRevert } from "../sdk-ts/src/index.ts";

describe("in_doubt_matrix", () => {
  it("opened/no-closed, 5xx, timeout, started+expired lease; VR5011 blocks undo", async () => {
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const action = {
      kind: "http" as const,
      name: "http.POST.api.example.com/d",
      target: "api.example.com",
      locality: "external" as const,
    };

    const openedSaga = await v.openSaga({ key: "opened" });
    await openEffect(v, openedSaga.id, {
      action,
      args: { method: "POST", url: "https://api.example.com/d", body: { id: "o" } },
      run: async () => ({ status: 201 }),
    });
    await v.resumeSaga(openedSaga.id);
    const opened = (await v.ledgerHandle!.listEffects(openedSaga.id))[0]!;
    expect(opened.status).toBe("in_doubt");
    await expect(v.undo(openedSaga.id, { probe: async () => "unknown" as const, probeOpts: { backoffMs: [1, 1, 1] } })).rejects.toSatisfy(
      (err: unknown) => err instanceof VekRevertError && err.code === "VR5011",
    );

    const s5 = await v.openSaga({ key: "five" });
    await s5.effect({
      action,
      args: { method: "POST", url: "https://api.example.com/d5", body: { id: "5" } },
      run: async () => ({ status: 500, headers: {}, body: null }),
    });
    const row5 = (await v.ledgerHandle!.listEffects(s5.id))[0]!;
    expect(row5.status).toBe("in_doubt");

    const st = await v.openSaga({ key: "timeout" });
    await st.effect({
      action,
      args: { method: "POST", url: "https://api.example.com/dt", body: { id: "t" } },
      run: async () => ({ timeout: true }),
    });
    const rowT = (await v.ledgerHandle!.listEffects(st.id))[0]!;
    expect(rowT.status).toBe("in_doubt");

    const se = await v.openSaga({ key: "started-expired" });
    await se.effect({
      action,
      args: { method: "POST", url: "https://api.example.com/se", body: { id: "se" } },
      run: async () => ({
        status: 201,
        headers: { Location: "https://api.example.com/se/1" },
        id: "se",
      }),
    });
    const eff = (await v.ledgerHandle!.listEffects(se.id))[0]!;
    await v.ledgerHandle!.appendAttempt({
      attempt_id: "att_started_expired",
      idempotency_key: "vr1_started_expired_key_00000000001",
      effect_id: eff.effect_id,
      plan_id: "cpl_x",
      step_index: 0,
      fence: 1,
      state: "started",
      started_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const rk = Array.isArray(eff.resource_keys) ? eff.resource_keys : [];
    const leaseKey = typeof rk[0] === "string" ? rk[0] : "http:api.example.com/se/1";
    await v.ledgerHandle!.acquireLease(leaseKey, "old:holder:1", { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    eff.status = "in_doubt";
    await v.ledgerHandle!.upsertEffect(eff);
    await expect(v.undo(se.id, { probe: async () => "unknown" as const, probeOpts: { backoffMs: [1, 1, 1] } })).rejects.toSatisfy(
      (err: unknown) => err instanceof VekRevertError && err.code === "VR5011",
    );

    const landed = await v.openSaga({ key: "landed-probe" });
    await landed.effect({
      action,
      args: { method: "POST", url: "https://api.example.com/ok", body: { id: "ok" } },
      run: async () => ({ timeout: true }),
    });
    v.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const report = await v.undo(landed.id, { probe: async () => "landed" as const, probeOpts: { backoffMs: [1, 1, 1] } });
    expect(report.effects[0]?.outcome === "compensated" || report.effects[0]?.outcome === "escalated").toBe(true);
  });
});
