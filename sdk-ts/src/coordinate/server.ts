/** Cross-ledger coordinator HTTP process. Per-resource leases, not a global lock. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ReceiptEvent } from "@latticeag/vekrevert-events";
import { CoordinatorStore, type ConflictVerdict } from "./store.ts";

export type { ConflictVerdict };

export interface CoordinatorListenOpts {
  host?: string;
  port?: number;
  dbPath?: string;
  db?: string;
  listen?: string;
  apiKey?: string;
  now?: () => Date;
}

export interface CoordinatorHandle {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
}

export interface CoordinatorServer {
  server: Server;
  store: CoordinatorStore;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function tail(pathname: string): string {
  return pathname.replace(/\/+$/, "").replace(/^\/v1(?=\/)/, "") || "/";
}

export function parseListen(raw: string | undefined): { host: string; port: number } {
  const v = raw ?? "127.0.0.1:7465";
  const idx = v.lastIndexOf(":");
  if (idx <= 0) return { host: "127.0.0.1", port: Number(v) || 7465 };
  return { host: v.slice(0, idx), port: Number(v.slice(idx + 1)) || 0 };
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export function createCoordinatorServer(opts: CoordinatorListenOpts = {}): CoordinatorServer {
  const store = new CoordinatorStore(opts.dbPath ?? opts.db ?? ":memory:");
  const wantKey = opts.apiKey;
  const nowFn = opts.now ?? (() => new Date());

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = tail(url.pathname);
    try {
      const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
      if (wantKey && auth !== `Bearer ${wantKey}`) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && (path === "/health" || path === "/")) {
        send(res, 200, { v: "vekrevert/v1", role: "coordinator" });
        return;
      }
      if (req.method === "POST" && path === "/leases") {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const op = String(body.op ?? "");
        const resourceKey = String(body.resource_key ?? "");
        if (!resourceKey) {
          send(res, 400, { error: "resource_key required" });
          return;
        }
        const holder = String(body.holder ?? "");
        const ttlMs = typeof body.ttlMs === "number" ? body.ttlMs : Number(body.ttlMs);
        const fence = Number(body.fence);
        const now = nowFn();

        if (op === "acquire") {
          if (!holder) {
            send(res, 400, { error: "holder required" });
            return;
          }
          const out = store.acquire(resourceKey, holder, Number.isFinite(ttlMs) ? ttlMs : undefined, now);
          if ("error_code" in out) {
            send(res, 409, out);
            return;
          }
          send(res, 200, { fence: out.fence, expires_at: out.expires_at });
          return;
        }
        if (op === "renew") {
          const out = store.renew(resourceKey, holder, fence, Number.isFinite(ttlMs) ? ttlMs : undefined, now);
          if ("error_code" in out) {
            send(res, 412, out);
            return;
          }
          send(res, 200, out);
          return;
        }
        if (op === "release") {
          const out = store.release(resourceKey, holder, fence);
          if ("error_code" in out) {
            send(res, 412, out);
            return;
          }
          send(res, 200, {});
          return;
        }
        if (op === "get") {
          send(res, 200, { lease: store.getLease(resourceKey) });
          return;
        }
        send(res, 400, { error: `unknown op ${op}` });
        return;
      }
      if (req.method === "POST" && path === "/conflicts") {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const resource_key = String(body.resource_key ?? "");
        const holder = String(body.holder ?? "");
        const fence = Number(body.fence);
        if (!resource_key || !holder || !Number.isFinite(fence)) {
          send(res, 400, { error: "resource_key, holder, fence required" });
          return;
        }
        const phase = body.phase === "commit" || body.commit === true ? true : body.phase === "intent" ? false : Boolean(body.commit);
        const error_code = typeof body.error_code === "string" ? body.error_code : undefined;
        const verdict: ConflictVerdict = store.conflict({
          resource_key,
          holder,
          fence,
          saga_id: String(body.saga_id ?? ""),
          plan_hash: String(body.plan_hash ?? ""),
          error_code,
          commit: phase,
        });
        send(res, 200, verdict);
        return;
      }
      if (req.method === "POST" && path === "/events") {
        const ev = JSON.parse(await readBody(req)) as ReceiptEvent;
        store.putEvent(ev);
        send(res, 200, { hash: ev.hash });
        return;
      }
      if (req.method === "GET" && path === "/events") {
        const sagaId = url.searchParams.get("saga_id") ?? undefined;
        send(res, 200, { events: store.listEvents(sagaId) });
        return;
      }
      send(res, 404, { error: "not_found" });
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => {
        try {
          store.close();
        } catch {
          /* already closed */
        }
        resolve();
      });
    });

  return { server, store, close };
}

export function listenCoordinator(opts: CoordinatorListenOpts = {}): Promise<CoordinatorHandle> {
  const created = createCoordinatorServer(opts);
  const fromListen = opts.listen ? parseListen(opts.listen) : undefined;
  const host = opts.host ?? fromListen?.host ?? "127.0.0.1";
  const port = opts.port ?? fromListen?.port ?? 7465;
  return new Promise((resolve, reject) => {
    created.server.on("error", reject);
    created.server.listen(port, host, () => {
      const addr = created.server.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      const advertised = host === "0.0.0.0" ? "127.0.0.1" : host;
      resolve({
        url: `http://${advertised}:${bound}`,
        host: advertised,
        port: bound,
        close: created.close,
      });
    });
  });
}

/** Alias used by older call sites: `--listen host:port` plus `--db`. */
export function startCoordinator(opts: { db?: string; listen?: string; apiKey?: string; now?: () => Date } = {}): Promise<CoordinatorHandle> {
  const parsed = parseListen(opts.listen ?? "127.0.0.1:7465");
  return listenCoordinator({ host: parsed.host, port: parsed.port, dbPath: opts.db, apiKey: opts.apiKey, now: opts.now });
}
