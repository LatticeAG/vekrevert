/** packages/core/src/types.ts - VekRevert v1 type contract. */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Tier = "T1" | "T2" | "T3" | "T4";

export type EffectStatus =
  | "opened"
  | "landed"
  | "failed"
  | "in_doubt"
  | "abandoned";

export type CompensationState =
  | "none_required"
  | "unavailable"
  | "available"
  | "planned"
  | "verified"
  | "executing"
  | "compensated"
  | "failed"
  | "escalated"
  | "manually_resolved"
  | "superseded";

export type CaptureFidelity = "full" | "tool_only" | "http_only" | "degraded";

export type HttpMethod =
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "TRACE"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

export type SqlKind =
  | "SELECT"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "TRUNCATE"
  | "DROP"
  | "ALTER"
  | "CREATE"
  | "GRANT"
  | "REINDEX"
  | "VACUUM"
  | "CALL"
  | "EXEC"
  | "UNKNOWN";

export type SqlDialect = "sqlite" | "postgres" | "mysql" | "unknown";

export type FsOp =
  | "write"
  | "truncate"
  | "unlink"
  | "mkdir"
  | "rename"
  | "chmod"
  | "chown"
  | "utimes"
  | "open"
  | "stat"
  | "readdir"
  | "readlink";

export interface ActionRef {
  kind: "http" | "sql" | "fs" | "mcp_tool" | "sdk_fn" | "shell";
  /** Canonical dotted identity. Stable across runs. */
  name: string;
  version?: string;
  target?: string;
  locality: "internal" | "external" | "unknown";
}

export interface BindingExtractor {
  from: `args.${string}` | `result.${string}` | `header.${string}` | "status";
  required: boolean;
  pattern?: string;
}

export interface PreimageRef {
  kind: "fs_bytes" | "fs_absent" | "sql_rows" | "http_body" | "none";
  blob_id?: string;
  bytes?: number;
  rows?: number;
  truncated: boolean;
  meta?: Record<string, string | number>;
}

export interface CompensatorCandidate {
  id: string;
  score: number;
  source: "builtin" | "registered" | "drafted";
}

export interface ClassificationSource {
  source: "structural" | "locality" | "manifest" | "model";
  tier: Tier;
  reasons: string[];
}

export interface ClassificationRecord {
  tier: Tier;
  sources: ClassificationSource[];
  reasons: string[];
  candidates: CompensatorCandidate[];
  scope_violation: boolean;
}

export interface EffectReceipt {
  v: "vekrevert/v1";
  effect_id: string;
  saga_id: string;
  seq: number;
  compensation_of?: string;
  restore_sibling_of?: string;
  parent_effect_id?: string;

  action: ActionRef;
  tier: Tier;
  classification: ClassificationRecord;

  args_observed: JsonValue;
  args_hash: string;
  args_commitments?: Record<string, string>;
  intent_key: string;

  result_observed?: JsonValue;
  result_hash?: string;

  bindings: Record<string, JsonValue>;
  binding_paths: Record<string, string>;
  resource_keys: string[];

  preimage?: PreimageRef;

  status: EffectStatus;
  compensation_state: CompensationState;
  compensator_id?: string;

  capture: {
    fidelity: CaptureFidelity;
    interceptor: string;
    sdk_version: string;
    warnings: string[];
  };

  leak: "none" | "observers" | "downstream_effects";
  cascade_risk: "none" | "low" | "high";
  compensable_until?: string;

  opened_at: string;
  closed_at?: string;
  duration_ms?: number;
  redactions: string[];

  sealed: boolean;
  seal_hash?: string;
}

export type RefSource =
  | `receipt.bindings.${string}`
  | `receipt.args.${string}`
  | `receipt.result.${string}`
  | "receipt.preimage.blob"
  | "receipt.preimage.absent"
  | `const.${string}`
  | `credential.${string}`
  | "runtime.idempotency_key";

export interface Ref {
  $ref: RefSource;
}

export type ArgValue = Ref | ArgValue[] | { [key: string]: ArgValue };

export type SignatureMatcher =
  | { kind: "mcp_tool"; tool: string; version?: string }
  | { kind: "sdk_fn"; module: string; fn: string }
  | { kind: "http"; method: HttpMethod | HttpMethod[]; url_pattern: string }
  | { kind: "sql"; statement: SqlKind | SqlKind[]; table: string; dialect?: SqlDialect }
  | { kind: "fs"; op: FsOp | FsOp[]; path_glob: string }
  | { kind: "shell"; argv_template: string[] }
  | { kind: "*" };

export type Predicate =
  | { result_status_in: number[] }
  | { cascades: string[] }
  | { arg_equals: { path: string; value: JsonValue } }
  | { header_present: string }
  | { delete_undoes_create: boolean };

export interface DeclarativeCompensator {
  kind: "declarative";
  steps: CompensationStep[];
  postconditions?: Postcondition[];
}

export interface ProgrammaticCompensatorRef {
  kind: "programmatic";
  /** Module path the operator owns. Never transported by the hosted registry. */
  module: string;
  export?: string;
}

export interface ActionSignature {
  id: string;
  match: SignatureMatcher;
  applies_when?: Predicate[];
  tier: Tier;
  volatile?: string[];
  binds: Record<string, BindingExtractor>;
  preimage?: { required: boolean; kind: PreimageRef["kind"]; max_bytes?: number; max_rows?: number };
  compensator: DeclarativeCompensator | ProgrammaticCompensatorRef;
  constants?: Record<string, JsonValue>;
  credentials?: string[];
  scopes?: string[];
  permits?: string[];
  leak: "none" | "observers" | "downstream_effects";
  cascade_risk: "none" | "low" | "high";
  validity_window?: string;
  independent?: boolean;
  reversal_completeness: "full" | "partial" | "best_effort";
  signature?: string;
  source: "builtin" | "registered" | "drafted";
  delete_undoes_create?: boolean;
  probe?: boolean;
  /** Set at registration. Tie-break for matchCompensator (§6.2). */
  registered_at?: string;
  disabled?: boolean;
}

export interface CompensationPlan {
  v: "vekrevert/v1";
  plan_id: string;
  effect_id: string;
  saga_id: string;
  compensator_id: string;
  origin: "builtin" | "registered" | "drafted";
  steps: CompensationStep[];
  plan_hash: string;
  postconditions: Postcondition[];
  reversal_completeness: "full" | "partial" | "best_effort";
  leak: "none" | "observers" | "downstream_effects";
  cascade_risk: "none" | "low" | "high";
  summary: string;
  created_at: string;
  verification?: VerificationRecord;
}

export type CompensationStep =
  | {
      kind: "http_request";
      method: "DELETE" | "POST" | "PATCH" | "PUT";
      url: ArgValue;
      headers?: Record<string, ArgValue>;
      body?: ArgValue;
      expect: { status_in: number[]; treat_404_as_compensated?: boolean };
    }
  | {
      kind: "sql_statement";
      dialect: SqlDialect;
      statement: "INSERT" | "UPDATE" | "DELETE";
      table: ArgValue;
      where?: Record<string, ArgValue>;
      set?: Record<string, ArgValue>;
      values?: Record<string, ArgValue>;
      expect_rowcount: { min: number; max: number };
    }
  | {
      kind: "fs_restore";
      path: ArgValue;
      source: { $ref: "receipt.preimage.blob" } | { $ref: "receipt.preimage.absent" };
      restore_meta?: boolean;
    }
  | { kind: "fs_rename"; from: ArgValue; to: ArgValue }
  | { kind: "mcp_tool_call"; tool: ArgValue; args: ArgValue; expect?: { no_error: true } }
  | { kind: "noop"; reason: string }
  | { kind: "manual"; instructions: string; suggested_actions: string[] };

export interface Postcondition {
  step_index: number;
  kind: "http_status" | "row_count" | "file_hash" | "file_absent" | "tool_no_error" | "http_probe_absent";
  expected: JsonValue;
  required: boolean;
}

export interface VerificationRecord {
  verdict: "PASS" | "FAIL" | "UNSURE";
  scope_ok: boolean;
  sufficiency: "full" | "partial" | "no";
  overreach: boolean;
  order_ok: boolean;
  reasons: string[];
  model: string;
  drafter_model?: string;
  prompt_hash: string;
  plan_hash: string;
  latency_ms: number;
  verified_at: string;
}

export interface Saga {
  saga_id: string;
  key?: string;
  agent_id?: string;
  status: "open" | "closed" | "undoing" | "undone" | "partially_undone" | "failed";
  next_seq: number;
  opened_at: string;
  closed_at?: string;
  chain_head: string;
  chain_len: number;
}

export interface UndoReport {
  saga_id: string;
  requested_at: string;
  attempted: number;
  compensated: number;
  skipped: number;
  failed: number;
  escalated: number;
  halted_at_seq?: number;
  effects: Array<{
    seq: number;
    effect_id: string;
    action: string;
    tier: Tier;
    outcome: "compensated" | "failed" | "escalated" | "skipped" | "manual_required" | "not_attempted";
    reversal_completeness?: "full" | "partial" | "best_effort";
    leak?: "none" | "observers" | "downstream_effects";
    error_code?: string;
    escalation_id?: string;
  }>;
  world_restored: boolean;
}

export interface Actor {
  kind: "agent" | "human" | "system";
  id: string;
}

export type VRCode =
  | "VR1001"
  | "VR1004"
  | "VR1007"
  | "VR1010"
  | "VR1012"
  | "VR2001"
  | "VR2002"
  | "VR2005"
  | "VR2006"
  | "VR2011"
  | "VR2015"
  | "VR2020"
  | "VR2022"
  | "VR3001"
  | "VR3005"
  | "VR3006"
  | "VR3007"
  | "VR3008"
  | "VR3009"
  | "VR3010"
  | "VR3011"
  | "VR3012"
  | "VR3014"
  | "VR4001"
  | "VR4002"
  | "VR4003"
  | "VR4004"
  | "VR4005"
  | "VR5001"
  | "VR5002"
  | "VR5005"
  | "VR5006"
  | "VR5007"
  | "VR5009"
  | "VR5010"
  | "VR5011"
  | "VR5012"
  | "VR5014"
  | "VR6001"
  | "VR6003"
  | "VR6004"
  | "VR6006";

export const VR_MESSAGES: Record<VRCode, string> = {
  VR1001: "unknown_action_kind",
  VR1004: "scope_violation",
  VR1007: "shell_unclassifiable",
  VR1010: "t4_blocked",
  VR1012: "classifier_timeout",
  VR2001: "memory_ledger_in_production",
  VR2002: "wal_write_failed",
  VR2005: "preimage_too_large",
  VR2006: "preimage_unreadable",
  VR2011: "binding_missing",
  VR2015: "chain_broken",
  VR2020: "unresolved_in_doubt",
  VR2022: "projection_divergence",
  VR3001: "no_compensator_match",
  VR3005: "schema_invalid",
  VR3006: "unresolvable_ref",
  VR3007: "unprovenanced_literal",
  VR3008: "scope_violation",
  VR3009: "unsafe_statement",
  VR3010: "const_ref_in_drafted_plan",
  VR3011: "plan_too_large",
  VR3012: "impure_compensator",
  VR3014: "predicate_error",
  VR4001: "verifier_fail",
  VR4002: "verifier_unsure",
  VR4003: "verifier_timeout",
  VR4004: "overreach_detected",
  VR4005: "drafted_not_allowed",
  VR5001: "step_failed",
  VR5002: "postcondition_failed",
  VR5005: "lease_unavailable",
  VR5006: "concurrent_modification",
  VR5007: "window_expired",
  VR5009: "identity_changed",
  VR5010: "fenced",
  VR5011: "in_doubt_blocks_undo",
  VR5012: "illegal_transition",
  VR5014: "credential_scope_denied",
  VR6001: "vekinbox_unreachable",
  VR6003: "bad_signature",
  VR6004: "plan_hash_mismatch",
  VR6006: "escalation_declined",
};

export class VekRevertError extends Error {
  readonly code: VRCode;
  readonly detail?: string;

  constructor(code: VRCode, detail?: string) {
    super(`${code} ${VR_MESSAGES[code]}${detail ? `: ${detail}` : ""}`);
    this.name = "VekRevertError";
    this.code = code;
    this.detail = detail;
  }
}

export const SDK_VERSION = "0.1.0";

export const WEBHOOK_MAX_TIMESTAMP_SKEW_MS = 300_000;

export type EscalationReasonCode =
  | "t4_irreversible"
  | "verifier_rejected"
  | "compile_rejected"
  | "compensation_failed"
  | "unresolved_in_doubt"
  | "lease_unavailable"
  | "window_expired"
  | "cascade_risk"
  | "drafted_not_allowed";

export interface PlanRejection {
  ok: false;
  error_code: VRCode;
  stage: "schema" | "provenance" | "scope" | "compile" | "drafted";
  detail: string;
}

export interface ExecuteResult {
  plan_id: string;
  plan_hash: string;
  ok: boolean;
  postconditions_ok: boolean;
  attempt_ids: string[];
  duration_ms: number;
  error_code?: VRCode;
  reversal_completeness: "full" | "partial" | "best_effort";
  leak: "none" | "observers" | "downstream_effects";
}

export interface MatchResult {
  matched: ActionSignature | null;
  candidates: CompensatorCandidate[];
}

export interface RegisterResult {
  ok: boolean;
  ids: string[];
  error_code?: VRCode;
  detail?: string;
}

export interface SagaStatus {
  saga: Saga;
  effects: EffectReceipt[];
  pending: number;
  open_escalations: number;
  chain_head: string;
}

export interface ReceiptsReport {
  saga_id: string;
  events: unknown[];
  chain_ok?: boolean;
  broken_at?: number;
  reason?: string;
}

export interface Escalation {
  escalation_id: string;
  effect_id: string;
  saga_id: string;
  reason_code: EscalationReasonCode;
  approval_binds_to?: string;
  vekinbox_request_id?: string;
  status: "pending" | "resolved" | "declined";
}

export interface UndoOptions {
  toSeq?: number;
  dryRun?: boolean;
  continueOnFailure?: boolean;
  allowDrafted?: boolean;
}

export interface VekRevertConfig {
  ledger: string;
  agentId?: string;
  compensators?: Array<ActionSignature | string>;
  writableRoots?: string[];
  internalHosts?: string[];
  recordT1?: boolean;
  allowDrafted?: boolean;
  policy?: { blockT4?: boolean; requireApprovalFor?: string[] };
  limits?: {
    maxPreimageBytes?: number;
    maxPreimageRows?: number;
    maxPlanSteps?: number;
    maxCompensationRetries?: number;
  };
  lease?: { ttlMs?: number; heartbeatMs?: number; waitMs?: number };
  ledgerOpts?: {
    fsync?: "always" | "interval" | "never";
    fsyncIntervalMs?: number;
    anchorEvery?: number;
    anchorIntervalMs?: number;
  };
  redact?: { paths?: string[]; patterns?: string[] };
  credentials?: { provider: "env" | "file" | "vault" | "awssm" | "custom"; map?: Record<string, string> };
  models?: {
    classifier?: { model: string; timeoutMs: number; mode: "off_path" } | null;
    drafter?: { model: string; timeoutMs: number } | null;
    verifier?: { model: string; timeoutMs: number } | null;
  };
  escalation?: {
    vekinbox?: {
      baseUrl: string;
      apiKey?: string;
      workspaceId: string;
      resumeWebhook: string;
    };
    resumeWebhook?: string;
  };
}

export const DEFAULT_LIMITS = {
  maxPreimageBytes: 8 * 1024 * 1024,
  maxPreimageRows: 10_000,
  maxPlanSteps: 8,
  maxCompensationRetries: 3,
} as const;

export const DEFAULT_LEASE = {
  ttlMs: 30_000,
  heartbeatMs: 10_000,
  waitMs: 5_000,
} as const;

export const DEFAULT_LEDGER_OPTS = {
  fsync: "interval" as const,
  fsyncIntervalMs: 200,
  anchorEvery: 256,
  anchorIntervalMs: 60_000,
};

export interface TierEvidence {
  structural: Tier;
  locality: Tier;
  manifest?: { tier: Tier };
  model?: { tier: Tier };
  scopeViolation: boolean;
  compensatorMatched: boolean;
  reasons: string[];
}
