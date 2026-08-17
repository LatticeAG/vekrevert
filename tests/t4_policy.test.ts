import { describe, expect, it } from "vitest";
import { VekRevert, VekRevertError } from "../sdk-ts/src/index.ts";

const t4Action = {
  kind: "shell" as const,
  name: "shell.rm",
  target: "rm",
  locality: "unknown" as const,
};

describe("t4_policy", () => {
  it("default allows T4 forward", async () => {
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    expect(v.config.policy?.blockT4).toBe(false);
    const saga = await v.openSaga({ key: "t4-allow" });
    let ran = false;
    const value = await saga.effect({
      action: t4Action,
      args: { argv0: "rm", argv: ["-rf", "/tmp/x"] },
      run: async () => {
        ran = true;
        return "ok";
      },
    });
    expect(ran).toBe(true);
    expect(value).toBe("ok");
    const effects = await v.ledgerHandle!.listEffects(saga.id);
    expect(effects[0]!.tier).toBe("T4");
  });

  it("blockT4 true throws VR1010 at EP1 before run", async () => {
    const v = new VekRevert({
      ledger: "memory",
      policy: { blockT4: true },
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "t4-block" });
    let ran = false;
    await expect(
      saga.effect({
        action: t4Action,
        args: { argv0: "rm" },
        run: async () => {
          ran = true;
          return "nope";
        },
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof VekRevertError && err.code === "VR1010");
    expect(ran).toBe(false);
  });
});
