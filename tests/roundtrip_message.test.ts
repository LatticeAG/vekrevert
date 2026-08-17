import { describe, expect, it } from "vitest";
import {
  compilePlan,
  isPlanRejection,
  worldRestored,
  type CompensationPlan,
  type EffectReceipt,
  type UndoReport,
} from "@latticeag/vekrevert-core";
import { slackPostMessage } from "@latticeag/vekrevert-compensators";
import { executeStep, newAttemptId, projectionToReceipt, VekRevert } from "../sdk-ts/src/index.ts";

function compileBuiltin(receipt: EffectReceipt, v: VekRevert): CompensationPlan {
  const matched = v.registry.match(receipt.action, receipt.args_observed, receipt.result_observed);
  expect(matched.matched).toBeTruthy();
  const plan = compilePlan(receipt, matched.matched!, { origin: "builtin" });
  if (isPlanRejection(plan)) throw new Error(`${plan.error_code} ${plan.detail}`);
  return plan;
}

describe("roundtrip_message", () => {
  it("slack chat.delete retracts; completeness stays partial so world_restored is false", async () => {
    const deleted: Array<{ channel: string; ts: string }> = [];
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "slack-roundtrip" });
    await saga.effect({
      action: {
        kind: "mcp_tool",
        name: "mcp.slack.chat.postMessage",
        target: "slack",
        locality: "external",
      },
      args: { tool: "chat.postMessage", channel: "C1", text: "hi" },
      run: async () => ({ channel: "C1", ts: "123.456", ok: true }),
    });
    const receipt = projectionToReceipt((await v.ledgerHandle!.listEffects(saga.id))[0]!);
    const plan = compileBuiltin(receipt, v);
    expect(plan.reversal_completeness).toBe("partial");
    expect(plan.leak).toBe("observers");
    expect(plan.steps[0]?.kind).toBe("mcp_tool_call");
    await executeStep(plan.steps[0]!, {
      receipt,
      signature: slackPostMessage,
      attempt_id: newAttemptId(),
      permits: ["chat.delete"],
      mcpCall: (tool, args) => {
        expect(tool).toBe("chat.delete");
        const rec = args as { channel: string; ts: string };
        deleted.push({ channel: rec.channel, ts: rec.ts });
        return { ok: true };
      },
    });
    expect(deleted).toEqual([{ channel: "C1", ts: "123.456" }]);
    const report: UndoReport = {
      saga_id: saga.id,
      requested_at: new Date().toISOString(),
      attempted: 1,
      compensated: 1,
      skipped: 0,
      failed: 0,
      escalated: 0,
      effects: [
        {
          seq: 1,
          effect_id: receipt.effect_id,
          action: receipt.action.name,
          tier: receipt.tier,
          outcome: "compensated",
          reversal_completeness: plan.reversal_completeness,
          leak: plan.leak,
        },
      ],
      world_restored: worldRestored([
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
    };
    expect(report.world_restored).toBe(false);
  });

  it("SMTP classifies T4 and ships as a manual compensator", async () => {
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "smtp-t4" });
    await saga.effect({
      action: { kind: "mcp_tool", name: "mcp.smtp.send", target: "smtp", locality: "external" },
      args: { tool: "smtp.send", to: "a@example.com", text: "hello" },
      run: async () => ({ ok: true }),
    });
    const receipt = projectionToReceipt((await v.ledgerHandle!.listEffects(saga.id))[0]!);
    expect(receipt.tier).toBe("T4");
    const matched = v.registry.match(receipt.action, receipt.args_observed, receipt.result_observed);
    expect(matched.matched?.compensator.kind).toBe("declarative");
    expect(matched.matched?.compensator.kind === "declarative" && matched.matched.compensator.steps[0]?.kind).toBe("manual");
    const plan = compilePlan(receipt, matched.matched!, { origin: "builtin" });
    if (isPlanRejection(plan)) throw new Error(`${plan.error_code} ${plan.detail}`);
    expect(plan.reversal_completeness).toBe("partial");
    expect(plan.steps[0]?.kind).toBe("manual");
  });
});
