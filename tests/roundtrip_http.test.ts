import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  compilePlan,
  isPlanRejection,
  matchCompensator,
  type CompensationPlan,
  type EffectReceipt,
} from "@latticeag/vekrevert-core";
import { httpCreate } from "@latticeag/vekrevert-compensators";
import { executeStep, newAttemptId, projectionToReceipt, VekRevert } from "../sdk-ts/src/index.ts";

function compileBuiltin(receipt: EffectReceipt, v: VekRevert): CompensationPlan {
  const matched = v.registry.match(receipt.action, receipt.args_observed, receipt.result_observed);
  expect(matched.matched?.id).toBe("cmp_http_create@1");
  const plan = compilePlan(receipt, matched.matched!, { origin: "builtin" });
  if (isPlanRejection(plan)) throw new Error(`${plan.error_code} ${plan.detail}`);
  return plan;
}

describe("roundtrip_http", () => {
  it("POST 201 Location then DELETE; 404 is compensated", async () => {
    let store = new Map<string, string>([["it_1", "live"]]);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (req.method === "POST" && url.pathname === "/items") {
        res.statusCode = 201;
        res.setHeader("Location", `http://${req.headers.host}/items/it_1`);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "it_1" }));
        return;
      }
      if (req.method === "DELETE" && url.pathname === "/items/it_1") {
        expect(req.headers["x-vekrevert-compensation"]).toBeTruthy();
        if (!store.has("it_1")) {
          res.statusCode = 404;
          res.end();
          return;
        }
        store.delete("it_1");
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "http-roundtrip" });
    const action = {
      kind: "http" as const,
      name: `http.POST.127.0.0.1/items`,
      target: "127.0.0.1",
      locality: "external" as const,
    };
    const args = { method: "POST", url: `${base}/items`, body: { n: 1 } };
    await saga.effect({
      action,
      args,
      run: async () => {
        const res = await fetch(`${base}/items`, { method: "POST", body: JSON.stringify({ n: 1 }) });
        const body = (await res.json()) as { id: string };
        const headers: Record<string, string> = {};
        res.headers.forEach((val, key) => {
          headers[key] = val;
        });
        return { status: res.status, headers, id: body.id };
      },
    });
    const receipt = projectionToReceipt((await v.ledgerHandle!.listEffects(saga.id))[0]!);
    expect(receipt.bindings.resource_url).toContain("/items/it_1");
    const plan = compileBuiltin(receipt, v);
    expect(plan.steps[0]).toMatchObject({ kind: "http_request", method: "DELETE" });
    const first = await executeStep(plan.steps[0]!, {
      receipt,
      signature: httpCreate,
      attempt_id: newAttemptId(),
      fetch,
    });
    expect(first.status).toBe(204);
    expect(store.has("it_1")).toBe(false);
    const second = await executeStep(plan.steps[0]!, {
      receipt,
      signature: httpCreate,
      attempt_id: newAttemptId(),
      fetch,
    });
    expect(second.compensated_via_404).toBe(true);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("without delete_undoes_create the builtin does not match", () => {
    const action = {
      kind: "http" as const,
      name: "http.POST.api.example.com/v1/items",
      target: "api.example.com",
      locality: "external" as const,
    };
    const args = { method: "POST", url: "https://api.example.com/v1/items" };
    const result = { status: 201, headers: { Location: "https://api.example.com/v1/items/it_1" }, id: "it_1" };
    expect(matchCompensator([httpCreate], action, args, result).matched?.id).toBe("cmp_http_create@1");
    const clone = { ...httpCreate, delete_undoes_create: false };
    expect(matchCompensator([clone], action, args, result).matched).toBeNull();
  });
});
