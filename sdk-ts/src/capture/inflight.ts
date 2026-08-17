/** Best-effort in-flight effect linking when several interceptors see the same call (D5). */

import type { CaptureFidelity } from "@latticeag/vekrevert-core";

export interface InflightEffect {
  effect_id: string;
  fidelity: CaptureFidelity;
  intent_key: string;
}

const RANK: Record<CaptureFidelity, number> = {
  full: 4,
  tool_only: 3,
  http_only: 2,
  degraded: 1,
};

const inflight = new Map<string, InflightEffect>();

export function fidelityRank(f: CaptureFidelity): number {
  return RANK[f] ?? 0;
}

export function findInflight(intentKey: string): InflightEffect | undefined {
  return inflight.get(intentKey);
}

export function beginInflight(row: InflightEffect): void {
  if (!row.intent_key || !row.effect_id) return;
  inflight.set(row.intent_key, row);
}

export function endInflight(intentKey: string): void {
  inflight.delete(intentKey);
}
