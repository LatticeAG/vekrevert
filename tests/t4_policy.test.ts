import { afterEach, describe, expect, it } from "vitest";
import { VekRevert, VekRevertError } from "../sdk-ts/src/index.ts";
import { applyLexShieldPolicy, evaluateLexShield } from "../sdk-ts/src/policy/lexshield.ts";

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

  describe("lexshield", () => {
    const saved: Record<string, string | undefined> = {};
    const pending: Array<() => void> = [];

    function remember(name: string): void {
      if (!(name in saved)) saved[name] = process.env[name];
    }

    function setEnv(name: string, value: string | undefined): void {
      remember(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    function hangingFetch(): typeof fetch {
      return (() =>
        new Promise<Response>((_resolve, reject) => {
          pending.push(() => reject(Object.assign(new Error("test_cleanup"), { code: "TIMEOUT" })));
        })) as typeof fetch;
    }

    function unreachableFetch(): typeof fetch {
      return (async () => {
        throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      }) as typeof fetch;
    }

    afterEach(() => {
      while (pending.length) {
        const cancel = pending.pop();
        try {
          cancel?.();
        } catch {
          /* test teardown */
        }
      }
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
        delete saved[name];
      }
    });

    it("LexShield timeout/unreachable with policy.blockT4 true => VR1010, run() never called", async () => {
      setEnv("LEXSHIELD_URL", "http://127.0.0.1:1");
      setEnv("LEXSHIELD_TIMEOUT_MS", "80");
      const fetchFn = hangingFetch();
      const timedOut = await evaluateLexShield({
        tool: "shell.rm",
        args: { argv0: "rm" },
        timeoutMs: 50,
        fetch: fetchFn,
      });
      expect(timedOut.ok).toBe(false);
      if (!timedOut.ok) expect(["timeout", "unreachable"]).toContain(timedOut.status);
      expect(applyLexShieldPolicy(true, "T4", timedOut).block).toBe(true);

      const v = new VekRevert({
        ledger: "memory",
        policy: { blockT4: true },
        ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
      });
      v.fetch = fetchFn;
      const saga = await v.openSaga({ key: "t4-lexshield-block" });
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

      const vUnreach = new VekRevert({
        ledger: "memory",
        policy: { blockT4: true },
        ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
      });
      vUnreach.fetch = unreachableFetch();
      const sagaU = await vUnreach.openSaga({ key: "t4-lexshield-unreach-block" });
      let ranU = false;
      await expect(
        sagaU.effect({
          action: t4Action,
          args: { argv0: "rm" },
          run: async () => {
            ranU = true;
            return "nope";
          },
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof VekRevertError && err.code === "VR1010");
      expect(ranU).toBe(false);
    });

    it("LexShield timeout/unreachable with policy.blockT4 false records and continues; must not pretend ALLOW", async () => {
      setEnv("LEXSHIELD_URL", "http://127.0.0.1:1");
      setEnv("LEXSHIELD_TIMEOUT_MS", "80");
      const fetchFn = hangingFetch();
      const evalResult = await evaluateLexShield({
        tool: "shell.rm",
        args: { argv0: "rm" },
        timeoutMs: 50,
        fetch: fetchFn,
      });
      expect(evalResult.ok).toBe(false);
      if (!evalResult.ok) expect(["timeout", "unreachable"]).toContain(evalResult.status);
      const applied = applyLexShieldPolicy(false, "T4", evalResult);
      expect(applied.block).toBe(false);
      expect(applied.record).toMatch(/^lexshield_(timeout|unreachable)$/);
      expect(applied.record).not.toBe("lexshield_allow");

      const v = new VekRevert({
        ledger: "memory",
        policy: { blockT4: false },
        ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
      });
      v.fetch = fetchFn;
      const saga = await v.openSaga({ key: "t4-lexshield-continue" });
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
      const dumped = JSON.stringify({
        effects,
        events: await v.ledgerHandle!.readSaga(saga.id),
      });
      expect(dumped).not.toMatch(/lexshield_allow/);
      const reasons = (effects[0]!.classification as { reasons?: string[] } | undefined)?.reasons ?? [];
      if (reasons.some((r) => r.startsWith("lexshield_"))) {
        expect(reasons).not.toContain("lexshield_allow");
        expect(reasons.some((r) => r === "lexshield_timeout" || r === "lexshield_unreachable")).toBe(true);
      }

      const unreachEval = await evaluateLexShield({
        tool: "shell.rm",
        args: { argv0: "rm" },
        timeoutMs: 50,
        fetch: unreachableFetch(),
      });
      expect(unreachEval.ok).toBe(false);
      if (!unreachEval.ok) expect(unreachEval.status).toBe("unreachable");
      const appliedU = applyLexShieldPolicy(false, "T4", unreachEval);
      expect(appliedU.block).toBe(false);
      expect(appliedU.record).not.toBe("lexshield_allow");

      const vUnreach = new VekRevert({
        ledger: "memory",
        ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
      });
      vUnreach.fetch = unreachableFetch();
      const sagaU = await vUnreach.openSaga({ key: "t4-lexshield-unreach-continue" });
      let ranU = false;
      const valueU = await sagaU.effect({
        action: t4Action,
        args: { argv0: "rm" },
        run: async () => {
          ranU = true;
          return "ok";
        },
      });
      expect(ranU).toBe(true);
      expect(valueU).toBe("ok");
    });

    it("blockT4 default remains false; unset policy does not change behavior", async () => {
      setEnv("LEXSHIELD_URL", undefined);
      setEnv("LEXSHIELD_TIMEOUT_MS", undefined);
      const unconfigured = await evaluateLexShield({ tool: "shell.rm", args: {} });
      expect(unconfigured.ok).toBe(false);
      if (!unconfigured.ok) expect(unconfigured.status).toBe("unconfigured");
      const v = new VekRevert({
        ledger: "memory",
        ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
      });
      expect(v.config.policy?.blockT4).toBe(false);
      const saga = await v.openSaga({ key: "t4-unset-policy" });
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
    });
  });
});
