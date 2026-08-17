import { describe, expect, it } from "vitest";
import type { ActionRef, JsonValue } from "@latticeag/vekrevert-core";
import { VekRevert } from "../sdk-ts/src/index.ts";

const action: ActionRef = {
  kind: "http",
  name: "http.POST.api.example.com/v1/invoices",
  target: "api.example.com",
  locality: "external",
};
const args: JsonValue = { customer: "acme", amount: 450 };

describe("restore sibling", () => {
  it("two create_invoice effects, same intent_key, restore_boundary between; both receipts exist; not collapsed", async () => {
    const v = new VekRevert({
      ledger: "memory",
      agentId: "billing-agent",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "invoice-run" });

    const first = await saga.effect({
      action,
      args,
      run: async () => ({
        status: 201,
        headers: { Location: "https://api.example.com/v1/invoices/inv_7f3a91" },
        id: "inv_7f3a91",
        created_at: "2026-08-17T10:00:00Z",
      }),
    });
    expect(first).toMatchObject({ id: "inv_7f3a91" });

    const resumed = await v.resumeSaga(saga.id, { restoreBoundary: true });
    const second = await resumed.effect({
      action,
      args,
      run: async () => ({
        status: 201,
        headers: { Location: "https://api.example.com/v1/invoices/inv_88b0c2" },
        id: "inv_88b0c2",
        created_at: "2026-08-17T10:04:11Z",
      }),
    });
    expect(second).toMatchObject({ id: "inv_88b0c2" });

    const effects = await v.ledgerHandle!.listEffects(saga.id);
    expect(effects).toHaveLength(2);
    expect(effects[0]!.intent_key).toBe(effects[1]!.intent_key);
    expect(effects[0]!.effect_id).not.toBe(effects[1]!.effect_id);
    expect(effects[1]!.restore_sibling_of).toBe(effects[0]!.effect_id);

    const events = await v.ledgerHandle!.readSaga(saga.id);
    expect(events.some((e) => e.type === "restore_boundary")).toBe(true);
    expect(events.some((e) => e.type === "effect_duplicate_suspected")).toBe(true);
    expect(events.filter((e) => e.type === "effect_closed")).toHaveLength(2);
    expect(events.filter((e) => e.type === "receipt_issued")).toHaveLength(2);

    expect(effects[0]!.sealed).toBe(1);
    expect(effects[1]!.sealed).toBe(1);
    expect(effects[0]!.status).toBe("landed");
    expect(effects[1]!.status).toBe("landed");
  });
});
