import { describe, expect, it } from "vitest";
import { VekRevert, wrapProxyRequest } from "../sdk-ts/src/index.ts";

describe("fidelity_downgrade", () => {
  it("proxy-captured fs write is T4 not T2 (no preimage, http_only)", async () => {
    const v = new VekRevert({
      ledger: "memory",
      writableRoots: ["/tmp"],
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "fid-proxy" });
    await wrapProxyRequest(v, {
      action: { kind: "fs", name: "fs.write./tmp/proxy.txt", target: "/tmp/proxy.txt", locality: "internal" },
      args: { op: "write", path: "/tmp/proxy.txt", realpath: "/tmp/proxy.txt" },
      run: async () => ({ ok: true }),
    });
    const effects = await v.ledgerHandle!.listEffects(saga.id);
    expect(effects.length).toBeGreaterThanOrEqual(1);
    const fsEff = effects.find((e) => e.action_kind === "fs") ?? effects[0]!;
    expect(fsEff.capture_fidelity).toBe("http_only");
    expect(fsEff.tier).toBe("T4");
    expect(String(JSON.stringify(fsEff.classification))).toMatch(/fidelity_downgrade|T4/);
  });

  it("SDK instrumentFs write with preimage stays T2", async () => {
    const v = new VekRevert({
      ledger: "memory",
      writableRoots: ["/tmp"],
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "fid-sdk" });
    await saga.effect({
      action: { kind: "fs", name: "fs.write./tmp/sdk.txt", target: "/tmp/sdk.txt", locality: "internal" },
      args: { op: "write", path: "/tmp/sdk.txt", realpath: "/tmp/sdk.txt" },
      capturePreimage: () => ({ kind: "fs_absent", meta: { realpath: "/tmp/sdk.txt" } }),
      run: async () => ({ ok: true }),
    });
    const effects = await v.ledgerHandle!.listEffects(saga.id);
    expect(effects[0]!.tier).toBe("T2");
    expect(effects[0]!.capture_fidelity).toBe("full");
  });
});
