import { afterEach, describe, expect, it } from "vitest";
import { isPlanRejection, VekRevertError } from "@latticeag/vekrevert-core";
import { httpCreate } from "@latticeag/vekrevert-compensators";
import { acquireAll, assertFences, openLedger, VekRevert } from "../sdk-ts/src/index.ts";

describe("lease_fencing", () => {
  it("expired holder resumes => VR5010; wait past waitMs => VR5005", async () => {
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    await v.openSaga({ key: "lease" });
    const ledger = v.ledgerHandle!;
    const keys = ["http:api.example.com:/items/it_1"];

    const heldA = await acquireAll(keys, {
      ledger,
      holder: "1:sag:attA",
      ttlMs: 25,
      waitMs: 0,
    });
    await new Promise((r) => setTimeout(r, 40));
    const heldB = await acquireAll(keys, {
      ledger,
      holder: "1:sag:attB",
      ttlMs: 5_000,
      waitMs: 0,
    });
    expect(heldB.fences.get(keys[0]!)).toBeGreaterThan(heldA.fences.get(keys[0]!)!);

    await expect(assertFences(keys, heldA, ledger)).rejects.toSatisfy(
      (err: unknown) => err instanceof VekRevertError && err.code === "VR5010",
    );

    const t0 = Date.now();
    await expect(
      acquireAll(keys, {
        ledger,
        holder: "1:sag:attC",
        ttlMs: 5_000,
        waitMs: 40,
        pollMs: 5,
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof VekRevertError && err.code === "VR5005");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
  });
});

describe("postgres two-instance leases", () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    it("skips postgres because DATABASE_URL is not set", () => {
      console.log("skipping postgres: DATABASE_URL not set");
      expect(true).toBe(true);
      return;
    });
    return;
  }

  const closers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (closers.length) {
      const h = closers.pop();
      await h?.close().catch(() => undefined);
    }
  });

  it("acquireAll on instance B with waitMs 0 throws VR5005", async () => {
    const a = await openLedger(url);
    const b = await openLedger(url);
    closers.push(a, b);
    const key = `http:lease.example.test:/phase9/${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const heldA = await acquireAll([key], {
      ledger: a,
      holder: `pgA:sag:att-${Date.now()}`,
      ttlMs: 30_000,
      waitMs: 0,
    });
    expect(heldA.fences.get(key)).toBeGreaterThan(0);
    await expect(
      acquireAll([key], {
        ledger: b,
        holder: `pgB:sag:att-${Date.now()}`,
        ttlMs: 30_000,
        waitMs: 0,
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof VekRevertError && err.code === "VR5005");
  });

  it("second VekRevert execute/undo hits VR5005 and raises EP5 lease_unavailable", async () => {
    const nonce = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const vA = new VekRevert({
      ledger: url,
      lease: { ttlMs: 30_000, heartbeatMs: 10_000, waitMs: 0 },
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const vB = new VekRevert({
      ledger: url,
      lease: { ttlMs: 30_000, heartbeatMs: 10_000, waitMs: 0 },
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await vA.openSaga({ key: `pg-undo-${nonce}` });
    if (vA.ledgerHandle) closers.push(vA.ledgerHandle);
    const loc = `https://lease.example.test/items/${nonce}`;
    await saga.effect({
      action: {
        kind: "http",
        name: "http.POST.lease.example.test/items",
        target: "lease.example.test",
        locality: "external",
      },
      args: { method: "POST", url: "https://lease.example.test/items", body: { n: 1 } },
      signature: httpCreate,
      run: async () => ({
        status: 201,
        headers: { Location: loc },
        id: nonce,
      }),
    });
    const row = (await vA.ledgerHandle!.listEffects(saga.id))[0]!;
    const compiled = await vA.plan(row.effect_id);
    if (isPlanRejection(compiled)) throw new Error(`${compiled.error_code} ${compiled.detail}`);
    const keys = (row.resource_keys as string[]) ?? [];
    expect(keys.length).toBeGreaterThan(0);
    await acquireAll(keys, {
      ledger: vA.ledgerHandle!,
      holder: `pgA:hold:${nonce}`,
      ttlMs: 30_000,
      waitMs: 0,
    });

    await expect(vB.execute(compiled.plan_id, { lease: { waitMs: 0, ttlMs: 30_000 } })).rejects.toSatisfy(
      (err: unknown) => err instanceof VekRevertError && err.code === "VR5005",
    );
    if (vB.ledgerHandle) closers.push(vB.ledgerHandle);
    const events = await vB.ledgerHandle!.readSaga(saga.id);
    const raised = events.filter((e) => e.type === "escalation_raised");
    expect(raised.length).toBeGreaterThan(0);
    expect(raised.some((e) => (e.payload as { reason_code?: string }).reason_code === "lease_unavailable")).toBe(true);

    const report = await vB.undo(saga.id, { lease: { waitMs: 0, ttlMs: 30_000, heartbeatMs: 10_000 } });
    const after = await vB.ledgerHandle!.readSaga(saga.id);
    const raisedAfter = after.filter((e) => e.type === "escalation_raised");
    expect(raisedAfter.some((e) => (e.payload as { reason_code?: string }).reason_code === "lease_unavailable")).toBe(
      true,
    );
    expect(report.failed + report.escalated).toBeGreaterThan(0);
  });
});
