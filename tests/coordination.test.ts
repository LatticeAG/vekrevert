import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { compilePlan, isPlanRejection, VekRevertError } from "@latticeag/vekrevert-core";
import {
  acquireAll,
  listenCoordinator,
  projectionToReceipt,
  submitConflict,
  VekRevert,
} from "../sdk-ts/src/index.ts";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "vr-coord-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  while (closers.length) {
    const fn = closers.pop();
    await fn?.().catch(() => undefined);
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

async function startCoord() {
  const handle = await listenCoordinator({ listen: "127.0.0.1:0", db: ":memory:" });
  closers.push(() => handle.close());
  return handle;
}

function client(dir: string, name: string, coordinatorUrl: string) {
  const v = new VekRevert({
    ledger: `sqlite:${join(dir, `${name}.db`)}`,
    coordinatorUrl,
    ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    lease: { ttlMs: 5_000, waitMs: 0, heartbeatMs: 0 },
  });
  closers.push(async () => {
    await v.ledgerHandle?.close().catch(() => undefined);
  });
  return v;
}

function acquireFromChild(url: string, key: string, holder: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const script = `
      const res = await fetch(${JSON.stringify(`${url}/leases`)}, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "acquire",
          resource_key: ${JSON.stringify(key)},
          holder: ${JSON.stringify(holder)},
          ttlMs: 5000
        })
      });
      const body = await res.json();
      process.stdout.write(JSON.stringify({ status: res.status, body }));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.on("close", (code) => {
      if (!out) reject(new Error(err || `child exit ${code}`));
      else resolve(JSON.parse(out) as { status: number; body: Record<string, unknown> });
    });
  });
}

describe("coordination", () => {
  it("two clients × two sqlite ledgers serialize on one resource; loser escalates", async () => {
    const coord = await startCoord();
    const dir = tmp();
    const a = client(dir, "a", coord.url);
    const b = client(dir, "b", coord.url);
    const sagaA = await a.openSaga({ key: "coord-a" });
    const sagaB = await b.openSaga({ key: "coord-b" });
    const key = "http:coord.example.test:/items/it_1";

    const heldA = await acquireAll([key], {
      ledger: a.ledgerHandle!,
      holder: "procA:sag:att",
      ttlMs: 5_000,
      waitMs: 0,
    });
    expect(heldA.fences.get(key)).toBe(1);

    await expect(
      acquireAll([key], {
        ledger: b.ledgerHandle!,
        holder: "procB:sag:att",
        ttlMs: 5_000,
        waitMs: 0,
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof VekRevertError && err.code === "VR5005");

    const child = await acquireFromChild(coord.url, key, "procChild:sag:att");
    expect(child.status).toBe(409);
    expect(child.body.error_code).toBe("VR5005");

    await a.ledgerHandle!.releaseLease(key, heldA.holder, heldA.fences.get(key)!);
    const heldB = await acquireAll([key], {
      ledger: b.ledgerHandle!,
      holder: "procB:sag:att2",
      ttlMs: 5_000,
      waitMs: 0,
    });
    expect(heldB.fences.get(key)).toBeGreaterThan(heldA.fences.get(key)!);

    const eventsA = await a.ledgerHandle!.readSaga(sagaA.id);
    expect(eventsA.some((e) => e.type === "saga_opened")).toBe(true);
    const eventsB = await b.ledgerHandle!.readSaga(sagaB.id);
    expect(eventsB.some((e) => e.type === "saga_opened")).toBe(true);
  });

  it("fence high-water survives release (does not reset to 1)", async () => {
    const coord = await startCoord();
    const dir = tmp();
    const v = client(dir, "hw", coord.url);
    await v.openSaga({ key: "hw" });
    const key = "fs:/tmp/coord-hw";
    const first = await acquireAll([key], { ledger: v.ledgerHandle!, holder: "h1", ttlMs: 5_000, waitMs: 0 });
    await v.ledgerHandle!.releaseLease(key, first.holder, first.fences.get(key)!);
    const second = await acquireAll([key], { ledger: v.ledgerHandle!, holder: "h2", ttlMs: 5_000, waitMs: 0 });
    expect(second.fences.get(key)).toBe((first.fences.get(key) ?? 0) + 1);
  });

  it("crash-injection: dead holder's lease expires, waiter proceeds after TTL", async () => {
    const coord = await startCoord();
    const dir = tmp();
    const a = client(dir, "crash-a", coord.url);
    const b = client(dir, "crash-b", coord.url);
    await a.openSaga({ key: "crash-a" });
    await b.openSaga({ key: "crash-b" });
    const key = "http:coord.example.test:/crash/1";
    const dead = await acquireAll([key], {
      ledger: a.ledgerHandle!,
      holder: "dead:sag:att",
      ttlMs: 80,
      waitMs: 0,
    });
    expect(dead.fences.get(key)).toBeGreaterThan(0);
    const waiter = await acquireAll([key], {
      ledger: b.ledgerHandle!,
      holder: "waiter:sag:att",
      ttlMs: 5_000,
      waitMs: 400,
      pollMs: 20,
    });
    expect(waiter.fences.get(key)).toBeGreaterThan(dead.fences.get(key)!);
  });

  it("conflicting compensations: first execute wins, second escalates, no double-apply", async () => {
    const coord = await startCoord();
    const dir = tmp();
    let deletes = 0;
    let releaseDelete!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const world = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (req.method === "POST" && url.pathname === "/items") {
        res.statusCode = 201;
        res.setHeader("Location", `http://${req.headers.host}/items/shared`);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "shared" }));
        return;
      }
      if (req.method === "DELETE" && url.pathname === "/items/shared") {
        void gate.then(() => {
          deletes += 1;
          res.statusCode = deletes === 1 ? 204 : 404;
          res.end();
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => world.listen(0, "127.0.0.1", resolve));
    closers.push(
      () =>
        new Promise((resolve, reject) => world.close((err) => (err ? reject(err) : resolve()))),
    );
    const { port } = world.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const a = client(dir, "exec-a", coord.url);
    const b = client(dir, "exec-b", coord.url);
    a.fetch = fetch;
    b.fetch = fetch;

    async function record(v: VekRevert, key: string) {
      const saga = await v.openSaga({ key });
      const action = {
        kind: "http" as const,
        name: "http.POST.127.0.0.1/items",
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
          res.headers.forEach((val, h) => {
            headers[h] = val;
          });
          return { status: res.status, headers, id: body.id };
        },
      });
      const receipt = projectionToReceipt((await v.ledgerHandle!.listEffects(saga.id))[0]!);
      const matched = v.registry.match(receipt.action, receipt.args_observed, receipt.result_observed);
      const plan = compilePlan(receipt, matched.matched!, { origin: "builtin" });
      if (isPlanRejection(plan)) throw new Error(plan.detail);
      await v.ledgerHandle!.putPlan(plan);
      return { saga, plan, receipt };
    }

    const recA = await record(a, "exec-a");
    const recB = await record(b, "exec-b");
    const keys = recA.receipt.resource_keys ?? [];
    expect(keys.length).toBeGreaterThan(0);

    const runningA = a.execute(recA.plan.plan_id, { fetch, lease: { ttlMs: 8_000, waitMs: 0, heartbeatMs: 0 } });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const lease = await a.ledgerHandle!.getLease(keys[0]!);
      if (lease?.holder) break;
      await new Promise((r) => setTimeout(r, 15));
    }

    await expect(b.execute(recB.plan.plan_id, { fetch, lease: { ttlMs: 8_000, waitMs: 0, heartbeatMs: 0 } })).rejects.toSatisfy(
      (err: unknown) => err instanceof VekRevertError && (err.code === "VR5005" || err.code === "VR5010"),
    );
    const eventsB = await b.ledgerHandle!.readSaga(recB.saga.id);
    expect(eventsB.some((e) => e.type === "escalation_raised")).toBe(true);

    releaseDelete();
    const resultA = await runningA;
    expect(resultA.ok).toBe(true);
    expect(deletes).toBe(1);
  });

  it("conflict claim: committed winner makes the other holder a loser", async () => {
    const coord = await startCoord();
    const winner = await submitConflict(coord.url, {
      resource_key: "sql:app:items:id=1",
      holder: "A",
      fence: 1,
      saga_id: "sag_a",
      plan_hash: "sha256:a",
      commit: true,
    });
    expect(winner.verdict).toBe("winner");
    const loser = await submitConflict(coord.url, {
      resource_key: "sql:app:items:id=1",
      holder: "B",
      fence: 2,
      saga_id: "sag_b",
      plan_hash: "sha256:b",
      error_code: "VR5006",
    });
    expect(loser.verdict).toBe("loser");
    expect(loser.winner?.holder).toBe("A");
  });

  it("unset coordinatorUrl keeps local leases (no HTTP)", async () => {
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    await v.openSaga({ key: "local" });
    const key = "fs:/tmp/local-only";
    const held = await acquireAll([key], { ledger: v.ledgerHandle!, holder: "local", ttlMs: 1_000, waitMs: 0 });
    expect(held.fences.get(key)).toBe(1);
    expect(v.config.coordinatorUrl).toBeUndefined();
  });
});
