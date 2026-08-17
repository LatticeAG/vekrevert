import { describe, expect, it } from "vitest";
import type { ActionRef } from "@latticeag/vekrevert-core";
import { VekRevert } from "../sdk-ts/src/index.ts";

describe("preimage cap (D9)", () => {
  it("over maxPreimageBytes => T4 + truncated true; blob not used for restore", async () => {
    const v = new VekRevert({
      ledger: "memory",
      limits: { maxPreimageBytes: 64 },
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "preimage-cap" });
    const action: ActionRef = {
      kind: "fs",
      name: "fs.write./tmp/vekrevert-cap.bin",
      target: "/tmp/vekrevert-cap.bin",
      locality: "internal",
    };
    const huge = new Uint8Array(128);
    huge.fill(7);

    await saga.effect({
      action,
      args: { op: "write", path: "/tmp/vekrevert-cap.bin" },
      capturePreimage: () => ({ kind: "fs_bytes", bytes: huge }),
      run: async () => ({ ok: true }),
    });

    const effects = await v.ledgerHandle!.listEffects(saga.id);
    expect(effects).toHaveLength(1);
    const eff = effects[0]!;
    expect(eff.tier).toBe("T4");
    expect(eff.preimage_truncated).toBe(1);
    expect(eff.preimage_blob_id == null || eff.preimage_blob_id === "").toBe(true);

    const events = await v.ledgerHandle!.readSaga(saga.id);
    const unavailable = events.find((e) => e.type === "compensation_unavailable");
    expect(unavailable).toBeTruthy();
    expect((unavailable!.payload as { reason_code: string }).reason_code).toBe("VR2005");

    if (eff.preimage_blob_id) {
      const blob = await v.ledgerHandle!.getBlob(eff.preimage_blob_id);
      expect(blob).toBeNull();
    }
  });
});
