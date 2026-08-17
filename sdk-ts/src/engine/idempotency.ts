/** Deterministic attempt keys. UNIQUE insert is the double-execution gate (§8.3). */

import { deriveIdempotencyKey } from "@latticeag/vekrevert-core";
import type { AttemptRecord, Ledger } from "../ledger/types.ts";

export function stepIdempotencyKey(input: {
  saga_id: string;
  effect_seq: number;
  compensator_id: string;
  plan_hash: string;
  step_index: number;
}): string {
  return deriveIdempotencyKey(input);
}

export async function lookupAttempt(ledger: Ledger, key: string): Promise<AttemptRecord | undefined> {
  return ledger.getAttemptByIdempotencyKey(key);
}

export { deriveIdempotencyKey };
