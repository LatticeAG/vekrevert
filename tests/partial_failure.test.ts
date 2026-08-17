import { describe, expect, it } from "vitest";
import { httpCreate } from "@latticeag/vekrevert-compensators";
import { VekRevert } from "../sdk-ts/src/index.ts";

async function threeHttp(v: VekRevert) {
  const saga = await v.openSaga({ key: `pf-${Math.random().toString(16).slice(2)}` });
  for (const id of ["a", "b", "c"]) {
    const url = `https://api.example.com/items`;
    await saga.effect({
      action: {
        kind: "http",
        name: "http.POST.api.example.com/items",
        target: "api.example.com",
        locality: "external",
      },
      args: { method: "POST", url: `${url}/${id}`, body: { id } },
      run: async () => ({ status: 201, headers: { Location: `${url}/${id}` }, id }),
    });
  }
  return saga;
}

describe("partial_failure", () => {
  it("halt leaves lower seq not_attempted", async () => {
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await threeHttp(v);
    v.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/c")) return new Response("nope", { status: 500 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const report = await v.undo(saga.id);
    const bySeq = new Map(report.effects.map((e) => [e.seq, e]));
    expect(bySeq.get(3)?.outcome).toBe("failed");
    expect(bySeq.get(2)?.outcome).toBe("not_attempted");
    expect(bySeq.get(1)?.outcome).toBe("not_attempted");
    expect(report.halted_at_seq).toBe(3);
    expect(report.world_restored).toBe(false);
  });

  it("--continue-on-failure continues past a failed effect", async () => {
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await threeHttp(v);
    v.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/c")) return new Response("nope", { status: 500 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const report = await v.undo(saga.id, { continueOnFailure: true });
    const bySeq = new Map(report.effects.map((e) => [e.seq, e.outcome]));
    expect(bySeq.get(3)).toBe("failed");
    expect(bySeq.get(2)).toBe("compensated");
    expect(bySeq.get(1)).toBe("compensated");
    expect(report.world_restored).toBe(false);
  });

  it("independent:true continues past that effect", async () => {
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    await v.registry.register(
      {
        ...httpCreate,
        id: "cmp_http_independent@1",
        independent: true,
        match: { kind: "http", method: ["POST", "PUT"], url_pattern: "https://api.example.com/ind/**" },
      },
      { force: true },
    );
    const saga = await v.openSaga({ key: "ind" });
    await saga.effect({
      action: {
        kind: "http",
        name: "http.POST.api.example.com/ok",
        target: "api.example.com",
        locality: "external",
      },
      args: { method: "POST", url: "https://api.example.com/ok", body: { id: "1" } },
      run: async () => ({
        status: 201,
        headers: { Location: "https://api.example.com/ok/1" },
        id: "1",
      }),
    });
    await saga.effect({
      action: {
        kind: "http",
        name: "http.POST.api.example.com/ind",
        target: "api.example.com",
        locality: "external",
      },
      args: { method: "POST", url: "https://api.example.com/ind", body: { id: "2" } },
      run: async () => ({
        status: 201,
        headers: { Location: "https://api.example.com/ind/2" },
        id: "2",
      }),
    });
    v.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/ind/")) return new Response("nope", { status: 500 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const report = await v.undo(saga.id);
    const bySeq = new Map(report.effects.map((e) => [e.seq, e.outcome]));
    expect(bySeq.get(2)).toBe("failed");
    expect(bySeq.get(1)).toBe("compensated");
  });
});
