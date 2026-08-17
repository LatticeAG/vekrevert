import { describe, expect, it } from "vitest";
import { VekRevertError, type ActionRef, type JsonValue } from "@latticeag/vekrevert-core";
import { VekRevert, openEffect, reconcileOpenedAsInDoubt, getCompensationContext } from "../sdk-ts/src/index.ts";
import type { ReceiptEvent } from "@latticeag/vekrevert-events";

const invoiceAction: ActionRef = {
  kind: "http",
  name: "http.POST.api.example.com/v1/invoices",
  target: "api.example.com",
  locality: "external",
};
const invoiceArgs: JsonValue = { customer: "acme", amount: 450 };

const getAction: ActionRef = {
  kind: "http",
  name: "http.GET.api.example.com/v1/invoices",
  target: "api.example.com",
  locality: "external",
};

function vr() {
  return new VekRevert({
    ledger: "memory",
    agentId: "test-agent",
    ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
  });
}

describe("wal crash injection", () => {
  it("test double throws AFTER EP1 fsync before run => effect status in_doubt (opened never closed)", async () => {
    const v = vr();
    const saga = await v.openSaga({ key: "crash-ep1" });
    const ledger = v.ledgerHandle!;
    const orig = ledger.append.bind(ledger);
    let crashed = false;
    ledger.append = async (event, opts) => {
      await orig(event, opts);
      if (!crashed && event.type === "effect_opened") {
        crashed = true;
        throw new Error("crash after EP1 fsync");
      }
    };

    await expect(
      saga.effect({
        action: invoiceAction,
        args: invoiceArgs,
        run: async () => {
          throw new Error("run must not execute");
        },
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof VekRevertError && e.code === "VR2002");

    const events = await ledger.readSaga(saga.id);
    expect(events.some((e: ReceiptEvent) => e.type === "effect_opened")).toBe(true);
    expect(events.some((e: ReceiptEvent) => e.type === "effect_closed")).toBe(false);

    const effects = await ledger.listEffects(saga.id);
    expect(effects).toHaveLength(1);
    expect(["opened", "in_doubt"]).toContain(effects[0]!.status);

    await reconcileOpenedAsInDoubt(v, saga.id);
    const after = await ledger.getEffect(effects[0]!.effect_id);
    expect(after?.status).toBe("in_doubt");
    expect((await ledger.readSaga(saga.id)).some((e) => e.type === "effect_closed")).toBe(false);
  });

  it("kill between run success and EP2 => in_doubt", async () => {
    const v = vr();
    const saga = await v.openSaga({ key: "crash-ep2" });
    const opened = await openEffect(v, saga.id, {
      action: invoiceAction,
      args: invoiceArgs,
      run: async () => ({ id: "inv_never_closed" }),
    });
    const value = await Promise.resolve({ id: "inv_landed_in_world", status: 201 });
    expect(value.id).toBe("inv_landed_in_world");
    expect(opened.recorded).toBe(true);

    await reconcileOpenedAsInDoubt(v, saga.id);
    const eff = await v.ledgerHandle!.getEffect(opened.effect_id);
    expect(eff?.status).toBe("in_doubt");
    const events = await v.ledgerHandle!.readSaga(saga.id);
    expect(events.some((e) => e.type === "effect_closed")).toBe(false);
  });

  it("successful run + EP2 write failure => returns value, fidelity degraded", async () => {
    expect(getCompensationContext()).toBeUndefined();
    const v = vr();
    const saga = await v.openSaga({ key: "ep2-fail" });
    const ledger = v.ledgerHandle!;
    const orig = ledger.append.bind(ledger);
    ledger.append = async (event, opts) => {
      if (event.type === "effect_closed" || event.type === "receipt_issued") {
        throw new Error("EP2 write failure");
      }
      return orig(event, opts);
    };

    const value = await saga.effect({
      action: invoiceAction,
      args: invoiceArgs,
      run: async () => ({ status: 201, id: "inv_ok", headers: { Location: "https://api.example.com/v1/invoices/inv_ok" } }),
    });
    expect(value).toMatchObject({ id: "inv_ok" });
    expect(v.captureFailures).toBeGreaterThan(0);
    const events = await ledger.readSaga(saga.id);
    expect(events.some((e) => e.type === "capture_degraded")).toBe(true);
    const effects = await ledger.listEffects(saga.id);
    expect(effects[0]?.capture_fidelity).toBe("degraded");
  });

  it("T1 recordT1 false: reversibility_classified emitted, NO effects row", async () => {
    const v = vr();
    const saga = await v.openSaga({ key: "t1" });
    const got = await saga.effect({
      action: getAction,
      args: { method: "GET", url: "https://api.example.com/v1/invoices" },
      run: async () => ({ status: 200, body: { ok: true } }),
    });
    expect(got).toMatchObject({ status: 200 });
    const ledger = v.ledgerHandle!;
    const events = await ledger.readSaga(saga.id);
    expect(events.some((e) => e.type === "reversibility_classified")).toBe(true);
    expect(events.some((e) => e.type === "effect_opened")).toBe(false);
    expect(await ledger.listEffects(saga.id)).toHaveLength(0);
  });
});
