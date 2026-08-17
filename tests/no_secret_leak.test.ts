import { describe, expect, it } from "vitest";
import { VekRevert, raise } from "../sdk-ts/src/index.ts";

const CANARY = "sk_live_CANARYSECRET99";

describe("no_secret_leak", () => {
  it("canary secret is absent from ledger events, logs, and vekinbox payload", async () => {
    const logs: string[] = [];
    const origErr = console.error;
    const origLog = console.log;
    console.error = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    process.env.STRIPE_SECRET_KEY = CANARY;
    const posted: string[] = [];
    const v = new VekRevert({
      ledger: "memory",
      redact: { paths: ["$.password", "$.token", "$.authorization", "$.ssn"], patterns: ["sk_live_[A-Za-z0-9]+"] },
      escalation: {
        vekinbox: {
          baseUrl: "https://inbox.test/v1",
          workspaceId: "ws_1",
          resumeWebhook: "https://agent.test/resume",
          apiKey: CANARY,
        },
      },
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    v.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ id: "req_1" }), { status: 200 });
    }) as typeof fetch;

    try {
      const saga = await v.openSaga({ key: "noleak" });
      await saga.effect({
        action: {
          kind: "http",
          name: "http.POST.api.stripe.com/v1/charges",
          target: "api.stripe.com",
          locality: "external",
        },
        args: {
          method: "POST",
          url: "https://api.stripe.com/v1/charges",
          authorization: CANARY,
          headers: { authorization: CANARY },
        },
        run: async () => ({ status: 201, id: "ch_1", headers: { Location: "https://api.stripe.com/v1/charges/ch_1" } }),
      });
      const row = (await v.ledgerHandle!.listEffects(saga.id))[0]!;
      await raise({
        ledger: v.ledgerHandle!,
        host: v,
        saga_id: saga.id,
        effect_id: row.effect_id,
        reason_code: "compensation_failed",
        fetch: v.fetch,
      });
      const events = await v.ledgerHandle!.readSaga(saga.id);
      const blob = JSON.stringify({ events, effects: await v.ledgerHandle!.listEffects(saga.id), posted, logs });
      expect(blob).not.toContain(CANARY);
    } finally {
      console.error = origErr;
      console.log = origLog;
      delete process.env.STRIPE_SECRET_KEY;
    }
  });
});
