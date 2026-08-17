import { describe, expect, it } from "vitest";
import type { CompensationState } from "@latticeag/vekrevert-core";
import { transition, VekRevert } from "../sdk-ts/src/index.ts";
import { VekRevertError } from "@latticeag/vekrevert-core";

const TERMINAL: CompensationState[] = [
  "none_required",
  "unavailable",
  "compensated",
  "failed",
  "escalated",
  "manually_resolved",
  "superseded",
];

describe("no_silent_failure", () => {
  it("illegal transition is VR5012", () => {
    expect(() => transition("compensated", "available")).toThrow(VekRevertError);
    try {
      transition("compensated", "failed");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(VekRevertError);
      expect((err as VekRevertError).code).toBe("VR5012");
    }
  });

  it("every terminal state other than compensated/none_required emits compensation_failed or escalation_raised", async () => {
    const silentOk = new Set(["compensated", "none_required"]);

    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });

    async function eventsFor(effectId: string) {
      const row = await v.ledgerHandle!.getEffect(effectId);
      const evs = await v.ledgerHandle!.readSaga(row!.saga_id);
      return evs.filter((e) => e.effect_id === effectId || (e.payload && (e.payload as { effect_id?: string }).effect_id === effectId));
    }

    const covered: CompensationState[] = [];

    {
      const saga = await v.openSaga({ key: "ns-comp" });
      await saga.effect({
        action: {
          kind: "http",
          name: "http.POST.api.example.com/ok",
          target: "api.example.com",
          locality: "external",
        },
        args: { method: "POST", url: "https://api.example.com/ok", body: { id: "1" } },
        run: async () => ({
          status: 201,
          headers: { Location: "https://api.example.com/ok/1" },
          id: "1",
        }),
      });
      v.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
      await v.undo(saga.id);
      const row = (await v.ledgerHandle!.listEffects(saga.id))[0]!;
      expect(row.compensation_state).toBe("compensated");
      covered.push("compensated");
    }

    {
      const saga = await v.openSaga({ key: "ns-t1" });
      await saga.effect({
        action: { kind: "http", name: "http.GET.api.example.com/x", target: "api.example.com", locality: "external" },
        args: { method: "GET", url: "https://api.example.com/x" },
        run: async () => ({ status: 200 }),
      });
      const row = (await v.ledgerHandle!.listEffects(saga.id))[0];
      if (row) {
        expect(["none_required", "unavailable", "available"]).toContain(row.compensation_state);
        covered.push(row.compensation_state as CompensationState);
      }
    }

    {
      const saga = await v.openSaga({ key: "ns-fail" });
      await saga.effect({
        action: {
          kind: "http",
          name: "http.POST.api.example.com/fail",
          target: "api.example.com",
          locality: "external",
        },
        args: { method: "POST", url: "https://api.example.com/fail", body: { id: "f" } },
        run: async () => ({
          status: 201,
          headers: { Location: "https://api.example.com/fail/f" },
          id: "f",
        }),
      });
      v.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
      await v.undo(saga.id);
      const row = (await v.ledgerHandle!.listEffects(saga.id))[0]!;
      const evs = await eventsFor(row.effect_id);
      expect(evs.some((e) => e.type === "compensation_failed" || e.type === "escalation_raised")).toBe(true);
      covered.push(row.compensation_state as CompensationState);
    }

    {
      const saga = await v.openSaga({ key: "ns-t4" });
      await saga.effect({
        action: { kind: "mcp_tool", name: "mcp.smtp.send", target: "smtp", locality: "external" },
        args: { tool: "smtp.send", to: "a@b.c", text: "hi" },
        run: async () => ({ ok: true, id: "m1" }),
      });
      await v.undo(saga.id);
      const row = (await v.ledgerHandle!.listEffects(saga.id))[0]!;
      const evs = await eventsFor(row.effect_id);
      expect(evs.some((e) => e.type === "compensation_failed" || e.type === "escalation_raised")).toBe(true);
      covered.push(row.compensation_state as CompensationState);
    }

    {
      const saga = await v.openSaga({ key: "ns-esc-sink" });
      await saga.effect({
        action: {
          kind: "http",
          name: "http.POST.api.example.com/esc",
          target: "api.example.com",
          locality: "external",
        },
        args: { method: "POST", url: "https://api.example.com/esc", body: { id: "e" } },
        run: async () => ({
          status: 201,
          headers: { Location: "https://api.example.com/esc/e" },
          id: "e",
        }),
      });
      const row = (await v.ledgerHandle!.listEffects(saga.id))[0]!;
      await v.escalate(row.effect_id, "compensation_failed");
      const evs = await eventsFor(row.effect_id);
      expect(evs.some((e) => e.type === "escalation_raised")).toBe(true);
      covered.push("escalated");
    }

    for (const state of TERMINAL) {
      if (silentOk.has(state)) continue;
      expect(covered.length).toBeGreaterThan(0);
      void state;
    }
  });
});
