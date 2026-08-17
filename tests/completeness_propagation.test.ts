import { describe, expect, it } from "vitest";
import { compilePlan, isPlanRejection, whatUndoDoesNotFix, worldRestored, type EffectReceipt } from "@latticeag/vekrevert-core";
import { fsWrite, slackPostMessage, sqlRow } from "@latticeag/vekrevert-compensators";
import { projectionToReceipt, VekRevert } from "../sdk-ts/src/index.ts";

describe("completeness_propagation", () => {
  it("copies leak, cascade_risk, and reversal_completeness from signature to plan", () => {
    for (const sig of [fsWrite, sqlRow, slackPostMessage]) {
      const v = new VekRevert({ ledger: "memory" });
      const receiptLike = {
        v: "vekrevert/v1" as const,
        effect_id: "eff_c",
        saga_id: "sag_c",
        seq: 1,
        action:
          sig.match.kind === "fs"
            ? { kind: "fs" as const, name: "fs.write./x", target: "/x", locality: "internal" as const }
            : sig.match.kind === "sql"
              ? { kind: "sql" as const, name: "sql.INSERT.app.t", target: "app", locality: "internal" as const }
              : { kind: "mcp_tool" as const, name: "mcp.slack.chat.postMessage", target: "slack", locality: "external" as const },
        tier: sig.tier,
        classification: { tier: sig.tier, sources: [], reasons: [], candidates: [], scope_violation: false },
        args_observed:
          sig.match.kind === "fs"
            ? { op: "write", path: "/x" }
            : sig.match.kind === "sql"
              ? { statement: "INSERT", table: "t", dialect: "sqlite" }
              : { tool: "chat.postMessage", channel: "C1" },
        args_hash: "sha256:x",
        intent_key: "sha256:x",
        result_observed:
          sig.match.kind === "sql"
            ? { id: 1 }
            : sig.match.kind === "mcp_tool"
              ? { channel: "C1", ts: "1.2" }
              : { ok: true },
        bindings:
          sig.match.kind === "sql"
            ? { pk: 1, table: "t" }
            : sig.match.kind === "mcp_tool"
              ? { channel: "C1", ts: "1.2" }
              : {},
        binding_paths: {},
        resource_keys:
          sig.match.kind === "fs"
            ? ["fs:/x"]
            : sig.match.kind === "sql"
              ? ["sql:sqlite:app:t:id=1"]
              : ["mcp:slack:chat.postMessage:1.2"],
        status: "landed" as const,
        compensation_state: "available" as const,
        capture: { fidelity: "full" as const, interceptor: "test", sdk_version: "0.1.0", warnings: [] },
        leak: sig.leak,
        cascade_risk: sig.cascade_risk,
        opened_at: "1970-01-01T00:00:00.000Z",
        redactions: [],
        sealed: true,
        preimage:
          sig.match.kind === "fs"
            ? { kind: "fs_bytes" as const, truncated: false, blob_id: "blob_x", meta: { realpath: "/x" } }
            : sig.match.kind === "sql"
              ? { kind: "sql_rows" as const, truncated: false, rows: 1 }
              : undefined,
      };
      const plan = compilePlan(receiptLike as unknown as EffectReceipt, sig, { origin: "builtin" });
      if (isPlanRejection(plan)) throw new Error(`${plan.error_code} ${plan.detail}`);
      expect(plan.leak).toBe(sig.leak);
      expect(plan.cascade_risk).toBe(sig.cascade_risk);
      expect(plan.reversal_completeness).toBe(sig.reversal_completeness);
      const gaps = whatUndoDoesNotFix(plan);
      expect(gaps.length).toBeGreaterThan(0);
      void v;
    }
  });

  it("receipt leak/cascade come from the matched builtin; slack cannot set world_restored", async () => {
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "completeness" });
    await saga.effect({
      action: { kind: "mcp_tool", name: "mcp.slack.chat.postMessage", target: "slack", locality: "external" },
      args: { tool: "chat.postMessage", channel: "C9", text: "x" },
      run: async () => ({ channel: "C9", ts: "9.9" }),
    });
    const receipt = projectionToReceipt((await v.ledgerHandle!.listEffects(saga.id))[0]!);
    expect(receipt.leak).toBe("observers");
    expect(receipt.cascade_risk).toBe("low");
    const plan = compilePlan(receipt, slackPostMessage, { origin: "builtin" });
    if (isPlanRejection(plan)) throw new Error(`${plan.error_code} ${plan.detail}`);
    expect(plan.reversal_completeness).toBe("partial");
    expect(
      worldRestored([
        {
          seq: 1,
          effect_id: receipt.effect_id,
          action: receipt.action.name,
          tier: receipt.tier,
          outcome: "compensated",
          reversal_completeness: plan.reversal_completeness,
          leak: plan.leak,
        },
      ]),
    ).toBe(false);
  });
});
