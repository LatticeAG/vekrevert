/** SQLite store for the cross-ledger coordinator. Per-resource leases, not a global lock. */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadCoordinatorSql } from "@latticeag/vekrevert-core";
import type { ReceiptEvent } from "@latticeag/vekrevert-events";

export interface CoordLease {
  resource_key: string;
  holder: string;
  acquired_at: string;
  expires_at: string;
  fence: number;
}

export interface CoordClaim {
  resource_key: string;
  holder: string;
  fence: number;
  saga_id: string;
  plan_hash: string;
  state: "claimed" | "committed";
  updated_at: string;
}

export interface ConflictVerdict {
  verdict: "winner" | "loser" | "in_doubt";
  resource_key: string;
  winner?: {
    holder: string;
    fence: number;
    saga_id: string;
    plan_hash: string;
    state: "claimed" | "committed";
  };
  loser?: { holder: string; fence: number; saga_id: string; plan_hash: string };
}

const TTL_MIN = 1;
const TTL_MAX = 300_000;
const TTL_DEFAULT = 30_000;

export function clampTtl(ttlMs?: number): number {
  if (ttlMs == null || !Number.isFinite(ttlMs)) return TTL_DEFAULT;
  return Math.min(TTL_MAX, Math.max(TTL_MIN, Math.floor(ttlMs)));
}

export class CoordinatorStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
      this.db = new DatabaseSync(path, { timeout: 5000 });
      this.db.exec("PRAGMA journal_mode=WAL");
    } else {
      this.db = new DatabaseSync(":memory:", { timeout: 5000 });
    }
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(loadCoordinatorSql("sqlite"));
  }

  nowIso(now = new Date()): string {
    return now.toISOString();
  }

  close(): void {
    this.db.close();
  }

  private highWater(key: string): number {
    const row = this.db.prepare("SELECT fence FROM coord_fence_hw WHERE resource_key = ?").get(key) as
      | { fence: number }
      | undefined;
    return row ? Number(row.fence) : 0;
  }

  private setHighWater(key: string, fence: number): void {
    this.db.prepare("INSERT INTO coord_fence_hw (resource_key, fence) VALUES (?, ?) ON CONFLICT(resource_key) DO UPDATE SET fence = excluded.fence").run(key, fence);
  }

  getLease(key: string): CoordLease | null {
    const row = this.db.prepare("SELECT * FROM coord_leases WHERE resource_key = ?").get(key) as CoordLease | undefined;
    return row
      ? {
          resource_key: String(row.resource_key),
          holder: String(row.holder),
          acquired_at: String(row.acquired_at),
          expires_at: String(row.expires_at),
          fence: Number(row.fence),
        }
      : null;
  }

  acquire(key: string, holder: string, ttlMs?: number, now = new Date()): CoordLease | { error_code: "VR5005" } {
    const nowIso = this.nowIso(now);
    const ttl = clampTtl(ttlMs);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getLease(key);
      if (existing && existing.holder !== holder && existing.expires_at > nowIso) {
        this.db.exec("ROLLBACK");
        return { error_code: "VR5005" };
      }
      const fence = this.highWater(key) + 1;
      const expires_at = new Date(now.getTime() + ttl).toISOString();
      const acquired_at = nowIso;
      if (existing) {
        this.db.prepare("UPDATE coord_leases SET holder = ?, acquired_at = ?, expires_at = ?, fence = ? WHERE resource_key = ?").run(holder, acquired_at, expires_at, fence, key);
      } else {
        this.db.prepare("INSERT INTO coord_leases (resource_key, holder, acquired_at, expires_at, fence) VALUES (?, ?, ?, ?, ?)").run(key, holder, acquired_at, expires_at, fence);
      }
      this.setHighWater(key, fence);
      this.db.exec("COMMIT");
      return { resource_key: key, holder, acquired_at, expires_at, fence };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* */
      }
      throw err;
    }
  }

  renew(key: string, holder: string, fence: number, ttlMs?: number, now = new Date()): { expires_at: string } | { error_code: "VR5010" } {
    const existing = this.getLease(key);
    if (!existing || existing.holder !== holder || existing.fence !== fence) {
      return { error_code: "VR5010" };
    }
    const expires_at = new Date(now.getTime() + clampTtl(ttlMs)).toISOString();
    this.db.prepare("UPDATE coord_leases SET expires_at = ? WHERE resource_key = ? AND holder = ? AND fence = ?").run(expires_at, key, holder, fence);
    return { expires_at };
  }

  release(key: string, holder: string, fence: number): { ok: true } | { error_code: "VR5010" } {
    const existing = this.getLease(key);
    if (!existing) return { ok: true };
    if (existing.holder !== holder || existing.fence !== fence) return { error_code: "VR5010" };
    this.db.prepare("DELETE FROM coord_leases WHERE resource_key = ?").run(key);
    return { ok: true };
  }

  getClaim(key: string): CoordClaim | null {
    const row = this.db.prepare("SELECT * FROM coord_claims WHERE resource_key = ?").get(key) as CoordClaim | undefined;
    return row
      ? {
          resource_key: String(row.resource_key),
          holder: String(row.holder),
          fence: Number(row.fence),
          saga_id: String(row.saga_id),
          plan_hash: String(row.plan_hash),
          state: row.state === "committed" ? "committed" : "claimed",
          updated_at: String(row.updated_at),
        }
      : null;
  }

  conflict(input: {
    resource_key: string;
    holder: string;
    fence: number;
    saga_id: string;
    plan_hash: string;
    error_code?: string;
    commit?: boolean;
  }): ConflictVerdict {
    const key = input.resource_key;
    const nowIso = this.nowIso();
    const lease = this.getLease(key);
    const claim = this.getClaim(key);
    const asWinner = (c: CoordClaim): NonNullable<ConflictVerdict["winner"]> => ({
      holder: c.holder,
      fence: c.fence,
      saga_id: c.saga_id,
      plan_hash: c.plan_hash,
      state: c.state,
    });

    if (input.error_code === "VR5006") {
      if (claim && (claim.holder !== input.holder || claim.fence !== input.fence)) {
        return {
          verdict: "loser",
          resource_key: key,
          winner: asWinner(claim),
          loser: { holder: input.holder, fence: input.fence, saga_id: input.saga_id, plan_hash: input.plan_hash },
        };
      }
      return { verdict: "in_doubt", resource_key: key };
    }

    if (lease && (lease.holder !== input.holder || lease.fence !== input.fence) && lease.expires_at > nowIso) {
      return {
        verdict: "loser",
        resource_key: key,
        winner: claim ? asWinner(claim) : { holder: lease.holder, fence: lease.fence, saga_id: "", plan_hash: "", state: "claimed" },
        loser: { holder: input.holder, fence: input.fence, saga_id: input.saga_id, plan_hash: input.plan_hash },
      };
    }

    if (claim && claim.state === "committed" && (claim.holder !== input.holder || claim.fence !== input.fence)) {
      return {
        verdict: "loser",
        resource_key: key,
        winner: asWinner(claim),
        loser: { holder: input.holder, fence: input.fence, saga_id: input.saga_id, plan_hash: input.plan_hash },
      };
    }

    const state = input.commit || claim?.state === "committed" ? "committed" : "claimed";
    this.db.prepare(
      `INSERT INTO coord_claims (resource_key, holder, fence, saga_id, plan_hash, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(resource_key) DO UPDATE SET holder=excluded.holder, fence=excluded.fence, saga_id=excluded.saga_id,
         plan_hash=excluded.plan_hash, state=excluded.state, updated_at=excluded.updated_at`,
    ).run(key, input.holder, input.fence, input.saga_id, input.plan_hash, state, nowIso);
    const saved = this.getClaim(key)!;
    return { verdict: "winner", resource_key: key, winner: asWinner(saved) };
  }

  putEvent(ev: ReceiptEvent): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO coord_events (id, saga_id, chain_seq, body, hash) VALUES (?, ?, ?, ?, ?)",
    ).run(ev.id, ev.saga_id, ev.chain_seq, JSON.stringify(ev), ev.hash);
  }

  listEvents(sagaId?: string): ReceiptEvent[] {
    const rows = sagaId
      ? (this.db.prepare("SELECT body FROM coord_events WHERE saga_id = ? ORDER BY chain_seq").all(sagaId) as Array<{ body: string }>)
      : (this.db.prepare("SELECT body FROM coord_events ORDER BY saga_id, chain_seq").all() as Array<{ body: string }>);
    return rows.map((r) => JSON.parse(r.body) as ReceiptEvent);
  }
}
