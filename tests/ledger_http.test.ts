import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  chainEvent,
  genesisHash,
  VekRevertError,
  type JsonValue,
} from "@latticeag/vekrevert-core";
import { openHttpLedger, openLedger, clientChain } from "../sdk-ts/src/index.ts";
import type { ReceiptEvent } from "@latticeag/vekrevert-events";

interface MockState {
  events: ReceiptEvent[];
  leases: Map<string, { holder: string; fence: number; expires_at: string; acquired_at: string }>;
  delayMs: number;
  forgeAckHash?: string;
  tamperOnGet?: boolean;
  requireBearer?: string;
  lastAuth?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function startMock(state: MockState): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (code: number, body: unknown) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    try {
      const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
      state.lastAuth = auth;
      if (state.requireBearer && auth !== `Bearer ${state.requireBearer}`) {
        send(401, { error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && url.pathname.endsWith("/health")) {
        send(200, { v: "vekrevert/v1" });
        return;
      }
      if (req.method === "POST" && url.pathname.endsWith("/events")) {
        if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
        const ev = JSON.parse(await readBody(req)) as ReceiptEvent;
        state.events.push(ev);
        send(200, { hash: state.forgeAckHash ?? ev.hash });
        return;
      }
      if (req.method === "GET" && url.pathname.endsWith("/events")) {
        const sagaId = url.searchParams.get("saga_id");
        let list = sagaId ? state.events.filter((e) => e.saga_id === sagaId) : [...state.events];
        if (state.tamperOnGet && list[0]) {
          list = [{ ...list[0], hash: "sha256:deadbeef" }, ...list.slice(1)];
        }
        send(200, { events: list });
        return;
      }
      if (req.method === "POST" && url.pathname.endsWith("/leases")) {
        const body = JSON.parse(await readBody(req)) as {
          op: string;
          resource_key: string;
          holder?: string;
          fence?: number;
          ttlMs?: number;
        };
        const now = new Date();
        const existing = state.leases.get(body.resource_key);
        if (body.op === "acquire") {
          if (existing && existing.holder !== body.holder && existing.expires_at > now.toISOString()) {
            send(409, { error_code: "VR5005" });
            return;
          }
          const fence = existing ? existing.fence + 1 : 1;
          const rec = {
            holder: body.holder ?? "",
            fence,
            acquired_at: now.toISOString(),
            expires_at: new Date(now.getTime() + (body.ttlMs ?? 30_000)).toISOString(),
          };
          state.leases.set(body.resource_key, rec);
          send(200, { fence, expires_at: rec.expires_at });
          return;
        }
        if (body.op === "release") {
          if (existing && (existing.holder !== body.holder || existing.fence !== body.fence)) {
            send(412, { error_code: "VR5010" });
            return;
          }
          state.leases.delete(body.resource_key);
          send(200, {});
          return;
        }
        if (body.op === "renew") {
          if (!existing || existing.holder !== body.holder || existing.fence !== body.fence) {
            send(412, { error_code: "VR5010" });
            return;
          }
          existing.expires_at = new Date(now.getTime() + (body.ttlMs ?? 30_000)).toISOString();
          send(200, { expires_at: existing.expires_at });
          return;
        }
        if (body.op === "get") {
          const lease = existing
            ? { resource_key: body.resource_key, ...existing }
            : null;
          send(200, { lease });
          return;
        }
      }
      send(404, { error: "not_found" });
    } catch (err) {
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1` });
    });
  });
}

function sampleEvent(sagaId: string, seq: number, prior: ReceiptEvent[]): ReceiptEvent {
  const prev_hash = prior.length ? prior[prior.length - 1]!.hash : genesisHash(sagaId);
  const body = {
    v: "vekrevert/v1" as const,
    id: `evt_http_${seq}_${Math.random().toString(16).slice(2)}`,
    type: "saga_opened" as const,
    ts: new Date().toISOString(),
    saga_id: sagaId,
    chain_seq: seq,
    actor: { kind: "system" as const, id: "test" },
    payload: { key: "http-test", agent_id: "test", sdk_version: "0.2.0" } as unknown as JsonValue,
    prev_hash,
  };
  return chainEvent(body, prev_hash) as ReceiptEvent;
}

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
});

describe("ledger_http", () => {
  it("write-behind is readable locally while the server flush is delayed", async () => {
    const state: MockState = { events: [], leases: new Map(), delayMs: 30 };
    const mock = await startMock(state);
    servers.push(mock.server);
    const ledger = openHttpLedger(mock.url, { flushIntervalMs: 5_000 });
    const sagaId = `sag_wb_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const ev = sampleEvent(sagaId, 1, []);
    await ledger.append(ev);
    expect(state.events.length).toBe(0);
    const local = await ledger.readSaga(sagaId);
    expect(local.some((e) => e.id === ev.id)).toBe(true);
    expect(local[0]!.hash).toBe(ev.hash);
    await ledger.close();
  });

  it("computes the chain client-side; server cannot supply the hash", async () => {
    const state: MockState = { events: [], leases: new Map(), delayMs: 0 };
    const mock = await startMock(state);
    servers.push(mock.server);
    const ledger = await openLedger(mock.url);
    const sagaId = "sag_chain";
    const ev = sampleEvent(sagaId, 1, []);
    const hashed = clientChain(ev, []);
    expect(hashed.hash).toBe(ev.hash);
    expect(hashed.hash.startsWith("sha256:")).toBe(true);
    await ledger.append(ev, { fsync: true });
    expect(state.events[0]!.hash).toBe(ev.hash);
    expect(state.events[0]!.prev_hash).toBe(genesisHash(sagaId));
    await ledger.close();
  });

  it("detects a forged server ACK hash as VR2015", async () => {
    const state: MockState = { events: [], leases: new Map(), delayMs: 0, forgeAckHash: "sha256:forged" };
    const mock = await startMock(state);
    servers.push(mock.server);
    const ledger = openHttpLedger(mock.url);
    const ev = sampleEvent("sag_forge", 1, []);
    await expect(ledger.append(ev, { fsync: true })).rejects.toSatisfy(
      (err: unknown) => err instanceof VekRevertError && err.code === "VR2015",
    );
    await ledger.close();
  });

  it("detects tampered GET history as a chain break", async () => {
    const state: MockState = { events: [], leases: new Map(), delayMs: 0 };
    const mock = await startMock(state);
    servers.push(mock.server);
    const ledger = openHttpLedger(mock.url);
    const ev = sampleEvent("sag_tamper", 1, []);
    await ledger.append(ev, { fsync: true });
    state.tamperOnGet = true;
    await expect(ledger.readSaga("sag_tamper")).rejects.toSatisfy(
      (err: unknown) => err instanceof VekRevertError && err.code === "VR2015",
    );
    await ledger.close();
  });

  it("round-trips an event through the hosted wire", async () => {
    const state: MockState = { events: [], leases: new Map(), delayMs: 0 };
    const mock = await startMock(state);
    servers.push(mock.server);
    const ledger = openHttpLedger(mock.url);
    const ev = sampleEvent("sag_rt", 1, []);
    await ledger.append(ev, { fsync: true });
    const got = await ledger.readSaga("sag_rt");
    expect(got.map((e) => e.id)).toContain(ev.id);
    expect(got.find((e) => e.id === ev.id)?.hash).toBe(ev.hash);
    await ledger.close();
  });

  it("hosted leases are server-authoritative (second acquire VR5005)", async () => {
    const state: MockState = { events: [], leases: new Map(), delayMs: 0 };
    const mock = await startMock(state);
    servers.push(mock.server);
    const a = openHttpLedger(mock.url);
    const b = openHttpLedger(mock.url);
    const key = `http:api.example.com:/hosted/${Date.now()}`;
    await a.acquireLease(key, "holder-a", { ttlMs: 30_000 });
    await expect(b.acquireLease(key, "holder-b", { ttlMs: 30_000 })).rejects.toSatisfy(
      (err: unknown) => err instanceof VekRevertError && err.code === "VR5005",
    );
    await a.close();
    await b.close();
  });

  it("sends Authorization Bearer when VEKREVERT_API_KEY is set", async () => {
    const prev = process.env.VEKREVERT_API_KEY;
    process.env.VEKREVERT_API_KEY = "vr_test_http_ledger";
    try {
      const state: MockState = {
        events: [],
        leases: new Map(),
        delayMs: 0,
        requireBearer: "vr_test_http_ledger",
      };
      const mock = await startMock(state);
      servers.push(mock.server);
      const ledger = openHttpLedger(mock.url);
      const ev = sampleEvent(`sag_auth_${Date.now()}`, 1, []);
      await ledger.append(ev, { fsync: true });
      expect(state.lastAuth).toBe("Bearer vr_test_http_ledger");
      expect(state.events[0]!.hash).toBe(ev.hash);
      await ledger.close();
    } finally {
      if (prev == null) delete process.env.VEKREVERT_API_KEY;
      else process.env.VEKREVERT_API_KEY = prev;
    }
  });
});
