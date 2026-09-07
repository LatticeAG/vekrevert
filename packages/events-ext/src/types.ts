/** packages/events-ext/src/types.ts - vekrevert/v1 namespaced additive extension (D19). */

import type { JsonValue, Tier, ActionRef, CaptureFidelity, EscalationReasonCode } from "@latticeag/vekrevert-core";

export type VekRevertEventType =
  | "saga_opened"
  | "reversibility_classified"
  | "effect_opened"
  | "effect_closed"
  | "effect_in_doubt"
  | "effect_probed"
  | "effect_duplicate_suspected"
  | "restore_boundary"
  | "compensation_unavailable"
  | "compensation_planned"
  | "compensation_rejected"
  | "compensation_verified"
  | "compensation_executed"
  | "compensation_failed"
  | "compensation_skipped"
  | "compensation_side_effect"
  | "escalation_raised"
  | "escalation_resolved"
  | "saga_undone"
  | "receipt_issued"
  | "ledger_anchored"
  | "capture_degraded"
  | "approval_granted";

export const RESERVED_UMBRELLA_NAMES = [
  "compensation_executed",
  "compensation_failed",
  "reversibility_classified",
  "receipt_issued",
  "approval_granted",
  "policy_decision",
] as const;

export interface LedgerAnchoredPayload {
  anchor_seq: number;
  merkle_root: string;
  saga_heads: Array<{ saga_id: string; chain_head: string; chain_len: number }>;
  prev_anchor_hash: string;
  anchored_at: string;
}

export interface VekRevertEventPayload {
  saga_opened: { key?: string; agent_id?: string; sdk_version: string };
  reversibility_classified: {
    action: ActionRef;
    tier: Tier;
    sources: unknown[];
    reasons: string[];
    candidates: unknown[];
    scope_violation: boolean;
  };
  effect_opened: {
    effect_id: string;
    seq: number;
    action: ActionRef;
    tier: Tier;
    args_hash: string;
    intent_key: string;
    preimage?: unknown;
  };
  effect_closed: {
    status: string;
    result_hash?: string;
    bindings: Record<string, JsonValue>;
    resource_keys: string[];
    duration_ms?: number;
    seal_hash?: string;
  };
  effect_in_doubt: { reason: string; probe_scheduled: boolean };
  effect_probed: { probe_result: "landed" | "not_landed" | "unknown"; attempts: number };
  effect_duplicate_suspected: {
    intent_key: string;
    restore_sibling_of: string;
    restore_boundary_seq: number;
  };
  restore_boundary: { checkpoint_hint?: string; prior_seq: number };
  compensation_unavailable: { reason_code: string; candidates_considered: number };
  compensation_planned: {
    plan_id: string;
    plan_hash: string;
    compensator_id: string;
    origin: string;
    step_kinds: string[];
  };
  compensation_rejected: { error_code: string; stage: string; detail: string };
  compensation_verified: Record<string, JsonValue>;
  compensation_executed: {
    plan_hash: string;
    attempt_ids: string[];
    postconditions_ok: boolean;
    reversal_completeness: string;
    leak: string;
    duration_ms: number;
    origin?: string;
    fencing_token?: { holder: string; fences: Record<string, number> };
  };
  compensation_failed: {
    error_code: string;
    step_index: number;
    attempts: number;
    postcondition_failed: boolean;
  };
  compensation_skipped: {
    reason: "already_compensated" | "t1" | "superseded" | "abandoned";
  };
  compensation_side_effect: { compensation_of: string; action: ActionRef };
  escalation_raised: {
    reason_code: EscalationReasonCode;
    vekinbox_request_id?: string;
    approval_binds_to?: string;
    priority: string;
  };
  escalation_resolved: {
    action: string;
    resolved_by: string;
    plan_hash?: string;
    executed: boolean;
  };
  saga_undone: Record<string, JsonValue>;
  receipt_issued: { effect_id: string; seal_hash: string; anchor_seq?: number };
  ledger_anchored: LedgerAnchoredPayload;
  capture_degraded: { effect_id?: string; warnings: string[]; fidelity: CaptureFidelity };
  approval_granted: { plan_hash: string; actor_id: string };
}

export interface ReceiptEvent<T extends VekRevertEventType = VekRevertEventType> {
  v: "vekrevert/v1";
  id: string;
  type: T;
  ts: string;
  saga_id: string;
  chain_seq: number;
  effect_id?: string;
  actor: { kind: "agent" | "human" | "system"; id: string };
  payload: VekRevertEventPayload[T];
  prev_hash: string;
  hash: string;
  sig?: string;
}

export const VEKREVERT_EVENT_TYPES: VekRevertEventType[] = [
  "saga_opened",
  "reversibility_classified",
  "effect_opened",
  "effect_closed",
  "effect_in_doubt",
  "effect_probed",
  "effect_duplicate_suspected",
  "restore_boundary",
  "compensation_unavailable",
  "compensation_planned",
  "compensation_rejected",
  "compensation_verified",
  "compensation_executed",
  "compensation_failed",
  "compensation_skipped",
  "compensation_side_effect",
  "escalation_raised",
  "escalation_resolved",
  "saga_undone",
  "receipt_issued",
  "ledger_anchored",
  "capture_degraded",
  "approval_granted",
];
