/** Resource-scoped pessimistic leases with fencing (D4). Sorted acquire prevents deadlock. */

import { DEFAULT_LEASE, VekRevertError } from "@latticeag/vekrevert-core";
import type { Ledger, LedgerKind } from "../ledger/types.ts";

/** Shared (cross-process) leases live on postgres and hosted http. Local kinds stay process-private. */
export function isSharedLeaseLedger(kind: LedgerKind | string | undefined): boolean {
  return kind === "postgres" || kind === "http";
}

export function leaseHolder(processId: string, sagaId: string, attemptId: string): string {
  return `${processId}:${sagaId}:${attemptId}`;
}

export interface AcquireAllOpts {
  ledger: Ledger;
  holder: string;
  ttlMs?: number;
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface HeldLeases {
  holder: string;
  fences: Map<string, number>;
  expires_at: Map<string, string>;
}

const RETRYABLE_LEASE = "VR5005";

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sortedResourceKeys(keys: string[]): string[] {
  return [...new Set(keys)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function acquireAll(resourceKeys: string[], opts: AcquireAllOpts): Promise<HeldLeases> {
  const keys = sortedResourceKeys(resourceKeys);
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE.ttlMs;
  const waitMs = opts.waitMs ?? DEFAULT_LEASE.waitMs;
  const pollMs = Math.max(1, opts.pollMs ?? Math.min(50, waitMs || 50));
  const sleep = opts.sleep ?? sleepDefault;
  const now = opts.now ?? Date.now;
  const deadline = now() + waitMs;
  const held: HeldLeases = { holder: opts.holder, fences: new Map(), expires_at: new Map() };

  if (keys.length === 0) return held;

  while (true) {
    try {
      for (const key of keys) {
        const got = await opts.ledger.acquireLease(key, opts.holder, { ttlMs });
        held.fences.set(key, got.fence);
        held.expires_at.set(key, got.expires_at);
      }
      return held;
    } catch (err) {
      await releaseAll(keys, held, opts.ledger).catch(() => undefined);
      held.fences.clear();
      held.expires_at.clear();
      const code = err instanceof VekRevertError ? err.code : undefined;
      if (code === RETRYABLE_LEASE && now() < deadline) {
        await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
        continue;
      }
      if (code === RETRYABLE_LEASE) throw new VekRevertError("VR5005", "lease_unavailable");
      throw err;
    }
  }
}

export async function releaseAll(keys: string[], held: HeldLeases, ledger: Ledger): Promise<void> {
  for (const key of [...keys].reverse()) {
    const fence = held.fences.get(key);
    if (fence == null) continue;
    try {
      await ledger.releaseLease(key, held.holder, fence);
    } catch (err) {
      if (err instanceof VekRevertError && err.code === "VR5010") throw err;
    }
  }
}

export async function heartbeatAll(
  keys: string[],
  held: HeldLeases,
  ledger: Ledger,
  ttlMs?: number,
): Promise<void> {
  for (const key of keys) {
    const fence = held.fences.get(key);
    if (fence == null) continue;
    const got = await ledger.renewLease(key, held.holder, fence, { ttlMs });
    held.expires_at.set(key, got.expires_at);
  }
}

export type FenceStatus = "ok" | "fenced" | "expired" | "held_elsewhere" | "missing";

export async function inspectFence(
  resourceKey: string,
  held: HeldLeases,
  ledger: Ledger,
  nowIso?: string,
): Promise<FenceStatus> {
  const current = await ledger.getLease(resourceKey);
  const want = held.fences.get(resourceKey);
  if (!current) return "missing";
  if (want != null && current.fence !== want) return "fenced";
  if (current.holder !== held.holder) {
    const n = nowIso ?? new Date().toISOString();
    if (current.expires_at > n) return "held_elsewhere";
    return "fenced";
  }
  const n = nowIso ?? new Date().toISOString();
  if (current.expires_at <= n) return "expired";
  return "ok";
}

export async function assertFences(keys: string[], held: HeldLeases, ledger: Ledger, nowIso?: string): Promise<void> {
  for (const key of keys) {
    const st = await inspectFence(key, held, ledger, nowIso);
    if (st === "fenced" || st === "held_elsewhere") throw new VekRevertError("VR5010", key);
    if (st === "expired" || st === "missing") throw new VekRevertError("VR5010", key);
  }
}
