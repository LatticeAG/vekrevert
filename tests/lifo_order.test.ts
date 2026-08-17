import { describe, expect, it } from "vitest";
import { VekRevertError } from "@latticeag/vekrevert-core";
import { VekRevert } from "../sdk-ts/src/index.ts";

async function httpSaga() {
  const v = new VekRevert({
    ledger: "memory",
    ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
  });
  const saga = await v.openSaga({ key: `lifo-${Math.random().toString(16).slice(2)}` });
  async function create(path: string, id: string) {
    const url = `https://api.example.com${path}`;
    await saga.effect({
      action: {
        kind: "http",
        name: `http.POST.api.example.com${path}`,
        target: "api.example.com",
        locality: "external",
      },
      args: { method: "POST", url, body: { id } },
      run: async () => ({ status: 201, headers: { Location: `${url}/${id}` }, id }),
    });
  }
  await create("/parents", "p1");
  await create("/children", "c1");
  return { v, saga };
}

describe("lifo_order", () => {
  it("compensates child then parent", async () => {
    const { v, saga } = await httpSaga();
    const order: string[] = [];
    v.fetch = (async (input: RequestInfo | URL) => {
      order.push(String(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const report = await v.undo(saga.id);
    expect(report.effects.map((e) => e.seq)).toEqual([2, 1]);
    expect(report.effects.every((e) => e.outcome === "compensated")).toBe(true);
    expect(order[0]).toContain("/children/c1");
    expect(order[1]).toContain("/parents/p1");
    expect(report.world_restored).toBe(true);
  });

  it("--to-seq N stops after that seq inclusive", async () => {
    const { v, saga } = await httpSaga();
    v.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const report = await v.undo(saga.id, { toSeq: 2 });
    const bySeq = new Map(report.effects.map((e) => [e.seq, e.outcome]));
    expect(bySeq.get(2)).toBe("compensated");
    expect(bySeq.get(1)).toBe("not_attempted");
    expect(report.halted_at_seq ?? 2).toBe(2);
    expect(report.world_restored).toBe(false);
  });

  it("dry-run undo does not call downstream", async () => {
    const { v, saga } = await httpSaga();
    let calls = 0;
    v.fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const report = await v.undo(saga.id, { dryRun: true });
    expect(calls).toBe(0);
    expect(report.world_restored).toBe(false);
    void VekRevertError;
  });
});
