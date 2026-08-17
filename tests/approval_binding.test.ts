import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WEBHOOK_MAX_TIMESTAMP_SKEW_MS as CORE_SKEW,
  compilePlan,
  isPlanRejection,
  type CompensationPlan,
  type EffectReceipt,
} from "@latticeag/vekrevert-core";
import { httpCreate } from "@latticeag/vekrevert-compensators";
import {
  VekRevert,
  WEBHOOK_MAX_TIMESTAMP_SKEW_MS,
  raise,
  onResume,
  getStoredEscalation,
} from "../sdk-ts/src/index.ts";

function sign(secret: string, timestamp: string, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

async function seeded(): Promise<{
  v: VekRevert;
  plan: CompensationPlan;
  receipt: EffectReceipt;
  key: string;
  secret: string;
}> {
  const secret = "whsec_test_binding";
  process.env.VEKINBOX_WEBHOOK_SECRET = secret;
  const v = new VekRevert({
    ledger: "memory",
    ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
  });
  const saga = await v.openSaga({ key: "approval" });
  await saga.effect({
    action: {
      kind: "http",
      name: "http.POST.api.example.com/v1/invoices",
      target: "api.example.com",
      locality: "external",
    },
    args: { method: "POST", url: "https://api.example.com/v1/invoices", body: { customer: "acme" } },
    signature: httpCreate,
    run: async () => ({
      status: 201,
      headers: { Location: "https://api.example.com/v1/invoices/inv_1" },
      id: "inv_1",
    }),
  });
  const row = (await v.ledgerHandle!.listEffects(saga.id))[0]!;
  const compiled = await v.plan(row.effect_id);
  if (isPlanRejection(compiled)) throw new Error(`${compiled.error_code} ${compiled.detail}`);
  const { key } = await raise({
    ledger: v.ledgerHandle!,
    host: v,
    saga_id: saga.id,
    effect_id: row.effect_id,
    reason_code: "compensation_failed",
    plan: compiled,
    signature: httpCreate,
  });
  const stored = getStoredEscalation(key)!;
  return { v, plan: compiled, receipt: stored.receipt, key, secret };
}

describe("approval_binding", () => {
  it("WEBHOOK_MAX_TIMESTAMP_SKEW_MS equals 300000", () => {
    expect(WEBHOOK_MAX_TIMESTAMP_SKEW_MS).toBe(300_000);
    expect(WEBHOOK_MAX_TIMESTAMP_SKEW_MS).toBe(CORE_SKEW);
  });

  it("HMAC fail => VR6003 and does not execute", async () => {
    const { v, key, secret } = await seeded();
    let executed = false;
    const ts = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ action: "approve_compensation", key, actor_id: "h1" });
    const result = await onResume(
      {
        "x-vekinbox-signature": "sha256=deadbeef",
        "x-vekinbox-timestamp": ts,
      },
      rawBody,
      {
        host: v,
        ledger: v.ledgerHandle,
        execute: async () => {
          executed = true;
          return {
            plan_id: "x",
            plan_hash: "x",
            ok: true,
            postconditions_ok: true,
            attempt_ids: [],
            duration_ms: 0,
            reversal_completeness: "full",
            leak: "none",
          };
        },
      },
    );
    expect(result.error_code).toBe("VR6003");
    expect(executed).toBe(false);
    void secret;
  });

  it("wrong plan_hash => VR6004 and re-escalates", async () => {
    const { v, key, secret, plan } = await seeded();
    const stored = getStoredEscalation(key)!;
    stored.plan = { ...plan, steps: [...plan.steps, { kind: "noop", reason: "mutated" }] };
    const ts = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ action: "approve_compensation", key, actor_id: "h1" });
    const sig = sign(secret, ts, rawBody);
    await expect(
      onResume(
        { "x-vekinbox-signature": sig, "x-vekinbox-timestamp": ts },
        rawBody,
        { host: v, ledger: v.ledgerHandle, execute: async () => { throw new Error("should not execute"); } },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof Error && /VR6004/.test(err.message));
  });

  it("structural gates re-run after approve", async () => {
    const { v, key, secret } = await seeded();
    const stored = getStoredEscalation(key)!;
    stored.receipt = { ...stored.receipt, resource_keys: ["http:evil.example:/nope"] };
    const ts = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      action: "approve_compensation",
      key,
      actor_id: "h1",
      plan_hash: stored.payload.approval_binds_to,
    });
    const sig = sign(secret, ts, rawBody);
    await expect(
      onResume(
        { "x-vekinbox-signature": sig, "x-vekinbox-timestamp": ts },
        rawBody,
        { host: v, ledger: v.ledgerHandle, execute: async () => { throw new Error("should not execute"); } },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof Error && /VR3008|VR3007|VR3006/.test(err.message));
  });
});

void compilePlan;
void seeded;
