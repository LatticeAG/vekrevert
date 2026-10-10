import fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VekRevert } from "../sdk-ts/src/index.ts";

/**
 * instrumentFs ran `import * as nodeFs` namespace assignment, which throws
 * `Cannot assign to read only property 'writeFileSync'` under ESM (tsx,
 * vitest, tsc NodeNext). It now patches the shared CommonJS exports object
 * that `require("node:fs")` and the ESM default import expose.
 *
 * Vitest itself runs ESM, so this whole suite is the regression test for the
 * namespace-assignment crash.
 */
describe("instrumentFs", () => {
  it("intercepts real fs writes under ESM and captures preimages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-instr-"));
    const p = join(dir, "target.txt");
    writeFileSync(p, "original-bytes");
    try {
      const v = new VekRevert({
        ledger: "memory",
        writableRoots: [tmpdir()],
        ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
      });
      const saga = await v.openSaga({ key: "instr-esm" });
      const instr = v.instrumentFs(); // must not throw the read-only namespace error
      try {
        // The default import is the patched shared exports object.
        fs.writeFileSync(p, "overwritten");
      } finally {
        instr[Symbol.dispose]();
      }

      // recordAfter is fire-and-forget for sync ops; poll for the row.
      let eff;
      for (let i = 0; i < 100 && !eff; i++) {
        const effects = await v.ledgerHandle!.listEffects(saga.id);
        eff = effects.find((e) => e.action_kind === "fs" && /write/.test(e.action_name));
        if (!eff) await new Promise((r) => setTimeout(r, 10));
      }
      expect(eff, "fs.write effect sealed by the instrumented call").toBeTruthy();
      expect(eff!.capture_interceptor).toBe("instrumentFs");
      expect(eff!.capture_fidelity).toBe("full");
      expect(eff!.preimage_kind).toBe("fs_bytes");
      expect(eff!.preimage_bytes).toBe("original-bytes".length);

      // undo runs the builtin fs_write compensation: bytes restored.
      await saga.undo();
      expect(readFileSync(p, "utf8")).toBe("original-bytes");
      const receipts = await v.receipts(saga.id, { verifyChain: true });
      expect(receipts.chain_ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores the original fs functions on dispose", async () => {
    const v = new VekRevert({ ledger: "memory" });
    const before = fs.writeFileSync;
    const instr = v.instrumentFs();
    expect(fs.writeFileSync).not.toBe(before);
    instr[Symbol.dispose]();
    expect(fs.writeFileSync).toBe(before);
  });
});
