import { describe, expect, it } from "vitest";
import { compilePlan, isPlanRejection, VekRevertError } from "@latticeag/vekrevert-core";
import { telegramSendMessage } from "@latticeag/vekrevert-compensators";
import { executeStep, newAttemptId, projectionToReceipt, VekRevert } from "../sdk-ts/src/index.ts";

describe("window_expiry", () => {
  it("telegram P2D: compile and execute after compensable_until is VR5007", async () => {
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "tg-window" });
    await saga.effect({
      action: {
        kind: "mcp_tool",
        name: "mcp.telegram.sendMessage",
        target: "telegram",
        locality: "external",
      },
      args: { tool: "telegram.sendMessage", chat_id: 1, text: "ping" },
      run: async () => ({ chat_id: 1, message_id: 99, ok: true }),
    });
    const receipt = projectionToReceipt((await v.ledgerHandle!.listEffects(saga.id))[0]!);
    expect(receipt.compensable_until).toBeTruthy();
    const until = Date.parse(receipt.compensable_until!);
    expect(until - Date.parse(receipt.opened_at)).toBe(2 * 24 * 60 * 60 * 1000);

    const ok = compilePlan(receipt, telegramSendMessage, { origin: "builtin", now: new Date(until - 1000) });
    if (isPlanRejection(ok)) throw new Error(`${ok.error_code} ${ok.detail}`);

    const expired = compilePlan(receipt, telegramSendMessage, { origin: "builtin", now: new Date(until + 1000) });
    expect(isPlanRejection(expired)).toBe(true);
    if (isPlanRejection(expired)) {
      expect(expired.error_code).toBe("VR5007");
    }

    await expect(
      executeStep(ok.steps[0]!, {
        receipt,
        signature: telegramSendMessage,
        attempt_id: newAttemptId(),
        now: new Date(until + 1000),
        mcpCall: () => ({ ok: true }),
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof VekRevertError && err.code === "VR5007");
  });
});
