/** EP5 stub. Appends escalation_raised. Phase 7 replaces this with the VekInbox client. */

import type { EscalationReasonCode, JsonValue } from "@latticeag/vekrevert-core";
import { appendChained, type EffectHost } from "../effect.ts";
import type { Ledger } from "../ledger/types.ts";
import { newEscalationId } from "../ulid.ts";

export interface EscalateEvent {
  ledger: Ledger;
  host: EffectHost;
  saga_id: string;
  effect_id?: string;
  reason_code: EscalationReasonCode;
  approval_binds_to?: string;
  priority?: string;
  vekinbox_request_id?: string;
}

const PRIORITY: Partial<Record<EscalationReasonCode, string>> = {
  t4_irreversible: "critical",
  unresolved_in_doubt: "critical",
  compensation_failed: "high",
  lease_unavailable: "high",
  cascade_risk: "high",
  verifier_rejected: "high",
  compile_rejected: "normal",
  window_expired: "normal",
  drafted_not_allowed: "normal",
};

export async function raise(event: EscalateEvent): Promise<{ escalation_id: string }> {
  const escalation_id = newEscalationId();
  const priority = event.priority ?? PRIORITY[event.reason_code] ?? "high";
  await appendChained(
    event.ledger,
    event.saga_id,
    "escalation_raised",
    {
      reason_code: event.reason_code,
      ...(event.vekinbox_request_id ? { vekinbox_request_id: event.vekinbox_request_id } : {}),
      ...(event.approval_binds_to ? { approval_binds_to: event.approval_binds_to } : {}),
      priority,
      escalation_id,
    } as unknown as JsonValue,
    event.host,
    event.effect_id,
  );
  return { escalation_id };
}
