/** Hosted HTTP ledger. Local write-behind buffer; chain computed client-side (D7). */

import {
  chainEvent,
  genesisHash,
  VekRevertError,
  canonicalize,
  verifyChain,
  type JsonValue,
} from "@latticeag/vekrevert-core";
import type { ReceiptEvent } from "@latticeag/vekrevert-events";
import {
  createMemoryLedger,
  isWalEvent,
  type AttemptRecord,
  type CompensatorRow,
  type Ledger,
  type LedgerOpenOptions,
  type LeaseAcquireOpts,
  type LeaseRecord,
} from "./types.ts";

const DEFAULT_FLUSH_MS = 200;

export function isHostedLedgerUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw.startsWith("https://") || raw.startsWith("http://");
}

export function hostedAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  const key = process.env.VEKREVERT_API_KEY;
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

export function joinLedgerUrl(base: string, path: string): string {
  const root = base.endsWith("/") ? base.slice(0, -1) : base;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${root}${suffix}`;
}

export function clientChain(event: ReceiptEvent, prior: ReceiptEvent[]): ReceiptEvent {
  const prev_hash = prior.length ? prior[prior.length - 1]!.hash : genesisHash(event.saga_id);
  const { hash: _ignored, sig: _sig, ...rest } = event;
  const chained = chainEvent(
    { ...rest, prev_hash, payload: rest.payload as unknown as JsonValue },
    prev_hash,
  );
  if (event.hash && event.hash !== chained.hash) {
    throw new VekRevertError("VR2015", "client hash does not match local chainEvent; refusing to send");
  }
  return chained as ReceiptEvent;
}

function vrFromRemote(code: unknown, fallback: "VR2002" | "VR2015" | "VR5005" | "VR5010"): never {
  if (code === "VR2015" || code === "VR2002" || code === "VR5005" || code === "VR5010") {
    throw new VekRevertError(code);
  }
  throw new VekRevertError(fallback);
}

async function readJson(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export interface HttpLedgerOpenOptions extends LedgerOpenOptions {
  flushIntervalMs?: number;
  apiKey?: string;
}

export function openHttpLedger(url: string, opts: HttpLedgerOpenOptions = {}): Ledger {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const inner = createMemoryLedger(opts, [], {}, "http");
  const pending: ReceiptEvent[] = [];
  let flushing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flushIntervalMs = opts.flushIntervalMs ?? opts.fsyncIntervalMs ?? DEFAULT_FLUSH_MS;

  function headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...hostedAuthHeaders(), "content-type": "application/json", ...extra };
    const key = opts.apiKey ?? process.env.VEKREVERT_API_KEY;
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  function requireFetch(): typeof fetch {
    if (!fetchFn) throw new VekRevertError("VR2002", "http ledger has no fetch; refusing to send");
    return fetchFn;
  }

  async function postEvents(events: ReceiptEvent[]): Promise<void> {
    const fetchImpl = requireFetch();
    for (const hashed of events) {
      let res: Response;
      try {
        res = await fetchImpl(joinLedgerUrl(url, "/events"), {
          method: "POST",
          headers: headers(),
          body: canonicalize(hashed as unknown as JsonValue),
        });
      } catch (err) {
        throw new VekRevertError("VR2002", `http ledger send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) {
        const body = await readJson(res);
        if (body?.error_code === "VR2015") vrFromRemote(body.error_code, "VR2015");
        throw new VekRevertError("VR2002", `http ledger refused: ${res.status}`);
      }
      const remote = await readJson(res);
      if (remote?.hash && remote.hash !== hashed.hash) {
        throw new VekRevertError("VR2015", "server returned a different hash; refusing forged history");
      }
    }
  }

  async function flushPending(): Promise<void> {
    if (flushing) {
      await flushing;
      return;
    }
    flushing = (async () => {
      while (pending.length) {
        const batch = pending.splice(0, pending.length);
        try {
          await postEvents(batch);
        } catch (err) {
          pending.unshift(...batch);
          throw err;
        }
      }
    })();
    try {
      await flushing;
    } finally {
      flushing = undefined;
    }
  }

  function scheduleFlush(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flushPending().catch(() => undefined);
    }, flushIntervalMs);
    timer.unref?.();
  }

  async function leaseRpc(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fetchImpl = requireFetch();
    let res: Response;
    try {
      res = await fetchImpl(joinLedgerUrl(url, "/leases"), {
        method: "POST",
        headers: headers(),
        body: canonicalize(body as JsonValue),
      });
    } catch (err) {
      throw new VekRevertError("VR5005", `hosted lease unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = (await readJson(res)) ?? {};
    if (res.status === 409 || parsed.error_code === "VR5005") {
      throw new VekRevertError("VR5005", "lease_unavailable");
    }
    if (res.status === 412 || parsed.error_code === "VR5010") {
      throw new VekRevertError("VR5010", "fenced");
    }
    if (!res.ok) {
      throw new VekRevertError("VR5005", `hosted lease refused: ${res.status}`);
    }
    return parsed;
  }

  async function pullSaga(sagaId: string): Promise<ReceiptEvent[]> {
    const fetchImpl = requireFetch();
    let res: Response;
    try {
      res = await fetchImpl(joinLedgerUrl(url, `/events?saga_id=${encodeURIComponent(sagaId)}`), {
        method: "GET",
        headers: headers(),
      });
    } catch {
      return [];
    }
    if (!res.ok) return [];
    const parsed = await readJson(res);
    const list = (Array.isArray(parsed) ? parsed : parsed?.events) as ReceiptEvent[] | undefined;
    if (!Array.isArray(list)) return [];
    const check = verifyChain(list as never);
    if (!check.ok) {
      throw new VekRevertError("VR2015", `server saga chain broken: ${check.reason} at ${check.brokenAt}`);
    }
    for (const ev of list) {
      const idx = list.indexOf(ev);
      const recomputed = clientChain(ev, list.slice(0, idx));
      if (recomputed.hash !== ev.hash || recomputed.prev_hash !== ev.prev_hash) {
        throw new VekRevertError("VR2015", "server event hash does not match client chainEvent; refusing forged history");
      }
    }
    return list;
  }

  const api: Ledger = {
    ...inner,
    kind: "http",
    async append(event, appendOpts) {
      const prior = await inner.readSaga(event.saga_id);
      const hashed = clientChain(event, prior);
      await inner.append(hashed, appendOpts);
      pending.push(hashed);
      const mandatory = isWalEvent(hashed.type);
      if (mandatory || appendOpts?.fsync === true) {
        await flushPending();
      } else {
        scheduleFlush();
      }
    },
    async readSaga(sagaId) {
      const remote = await pullSaga(sagaId).catch((err) => {
        if (err instanceof VekRevertError && err.code === "VR2015") throw err;
        return [] as ReceiptEvent[];
      });
      const local = await inner.readSaga(sagaId);
      if (!remote.length) return local;
      const have = new Set(remote.map((e) => e.id));
      const extra = local.filter((e) => !have.has(e.id));
      return [...remote, ...extra].sort((a, b) => a.chain_seq - b.chain_seq);
    },
    async readAll() {
      const fetchImpl = requireFetch();
      try {
        const res = await fetchImpl(joinLedgerUrl(url, "/events"), { method: "GET", headers: headers() });
        if (res.ok) {
          const parsed = await readJson(res);
          const list = (Array.isArray(parsed) ? parsed : parsed?.events) as ReceiptEvent[] | undefined;
          if (Array.isArray(list)) {
            const bySaga = new Map<string, ReceiptEvent[]>();
            for (const ev of list) {
              const arr = bySaga.get(ev.saga_id) ?? [];
              arr.push(ev);
              bySaga.set(ev.saga_id, arr);
            }
            for (const evs of bySaga.values()) {
              const check = verifyChain(evs as never);
              if (!check.ok) throw new VekRevertError("VR2015", `server chain broken: ${check.reason}`);
            }
          }
        }
      } catch (err) {
        if (err instanceof VekRevertError && err.code === "VR2015") throw err;
      }
      return inner.readAll();
    },
    async acquireLease(resourceKey, holder, leaseOpts?: LeaseAcquireOpts) {
      const got = await leaseRpc({
        op: "acquire",
        resource_key: resourceKey,
        holder,
        ttlMs: leaseOpts?.ttlMs,
      });
      const fence = Number(got.fence);
      const expires_at = String(got.expires_at ?? "");
      if (!Number.isFinite(fence) || !expires_at) {
        throw new VekRevertError("VR5005", "hosted lease response missing fence");
      }
      return { fence, expires_at };
    },
    async releaseLease(resourceKey, holder, fence) {
      await leaseRpc({ op: "release", resource_key: resourceKey, holder, fence });
    },
    async getLease(resourceKey): Promise<LeaseRecord | undefined> {
      try {
        const got = await leaseRpc({ op: "get", resource_key: resourceKey });
        const lease = (got.lease ?? got) as Partial<LeaseRecord> | null;
        if (!lease || !lease.resource_key) return undefined;
        return {
          resource_key: String(lease.resource_key),
          holder: String(lease.holder ?? ""),
          acquired_at: String(lease.acquired_at ?? ""),
          expires_at: String(lease.expires_at ?? ""),
          fence: Number(lease.fence ?? 0),
        };
      } catch (err) {
        if (err instanceof VekRevertError && err.code === "VR5005") return undefined;
        throw err;
      }
    },
    async renewLease(resourceKey, holder, fence, leaseOpts?: LeaseAcquireOpts) {
      const got = await leaseRpc({
        op: "renew",
        resource_key: resourceKey,
        holder,
        fence,
        ttlMs: leaseOpts?.ttlMs,
      });
      return { expires_at: String(got.expires_at ?? "") };
    },
    async appendAttempt(row: AttemptRecord) {
      await inner.appendAttempt(row);
      const fetchImpl = requireFetch();
      try {
        const res = await fetchImpl(joinLedgerUrl(url, "/attempts"), {
          method: "POST",
          headers: headers(),
          body: canonicalize(row as unknown as JsonValue),
        });
        if (!res.ok && res.status !== 404) {
          throw new VekRevertError("VR2002", `http ledger attempt refused: ${res.status}`);
        }
      } catch (err) {
        if (err instanceof VekRevertError) throw err;
        throw new VekRevertError("VR2002", `http ledger attempt send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    async upsertCompensator(row: CompensatorRow) {
      await inner.upsertCompensator(row);
      const fetchImpl = requireFetch();
      try {
        await fetchImpl(joinLedgerUrl(url, `/compensators/${encodeURIComponent(row.id)}`), {
          method: "PUT",
          headers: headers(),
          body: canonicalize(row as unknown as JsonValue),
        });
      } catch {
        /* registry persist is write-behind; local row already stored */
      }
    },
    async close() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      const lost = pending.length;
      if (lost > 0) {
        try {
          await flushPending();
        } catch (err) {
          // No silent loss: if the server is down at shutdown, say so loudly
          // instead of dropping the buffer quietly. Still complete the close
          // (error-isolation contract: bookkeeping failure must not convert a
          // successful run into a failed one).
          process.stderr.write(
            `vekrevert: http ledger close: ${lost} unflushed event(s) could not be sent ` +
              `(${err instanceof Error ? err.message : String(err)}); data may be lost\n`,
          );
        }
      }
      await inner.close();
    },
  };

  return api;
}
