import { describe, expect, it } from "vitest";
import { VekRevertError } from "@latticeag/vekrevert-core";
import { acquireAll, assertFences, VekRevert } from "../sdk-ts/src/index.ts";

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
