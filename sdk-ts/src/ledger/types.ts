/** Ledger interface shared by every driver. Chain math stays in core. */
import {
  DEFAULT_LEDGER_OPTS,
  DEFAULT_LEASE,
  VekRevertError,
  canonicalize,
  chainEvent,
  genesisHash,
  merkleRoot,
  sha256Hex,
  type CompensationPlan,
  type JsonValue,
  type Saga,
} from "@latticeag/vekrevert-core";
import type { ReceiptEvent } from "@latticeag/vekrevert-events";
import { newEventId } from "../ulid.ts";

export type LedgerKind = "memory" | "jsonl" | "sqlite" | "postgres" | "http";

export type FsyncMode = "always" | "interval" | "never";

export type LedgerClock = () => Date;

export interface LedgerOpenOptions {
  fsync?: FsyncMode;
  fsyncIntervalMs?: number;
  anchorEvery?: number;
  anchorIntervalMs?: number;
  clock?: LedgerClock;
  fetch?: typeof fetch;
}

export interface AppendOpts {
  fsync?: boolean;
}

export interface AttemptRecord {
  attempt_id: string;
  idempotency_key: string;
  effect_id: string;
  plan_id: string;
  step_index: number;
  fence: number;
  state: "started" | "succeeded" | "failed" | "in_doubt";
  started_at: string;
  finished_at?: string;
  error_code?: string;
  response_hash?: string;
}

export class DuplicateAttemptError extends Error {
  readonly idempotency_key: string;
  constructor(idempotency_key: string) {
    super(`UNIQUE constraint failed: attempts.idempotency_key (${idempotency_key})`);
    this.name = "DuplicateAttemptError";
    this.idempotency_key = idempotency_key;
  }
}

export function isDuplicateAttempt(err: unknown): boolean {
  if (err instanceof DuplicateAttemptError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: attempts\.idempotency_key/i.test(msg) || /duplicate key value.*idempotency_key/i.test(msg);
}

export interface LeaseRecord {
  resource_key: string;
  holder: string;
  acquired_at: string;
  expires_at: string;
  fence: number;
}

export interface BlobRecord {
  blob_id: string;
  bytes: number;
  created_at: string;
  refcount: number;
  storage: "inline" | "file" | "r2" | "s3";
  inline?: Uint8Array;
  path?: string;
}

export interface AnchorRecord {
  anchor_seq: number;
  merkle_root: string;
  saga_heads: Array<{ saga_id: string; chain_head: string; chain_len: number }>;
  prev_anchor_hash: string;
  hash: string;
  sig?: string;
  anchored_at: string;
}

export interface EffectProjection {
  effect_id: string;
  saga_id: string;
  seq: number;
  compensation_of?: string;
  restore_sibling_of?: string;
  parent_effect_id?: string;
  action_kind: string;
  action_name: string;
  action_target?: string;
  locality: string;
  tier: string;
  classification: JsonValue;
  args_observed: JsonValue;
  args_hash: string;
  args_commitments?: JsonValue;
  intent_key: string;
  result_observed?: JsonValue;
  result_hash?: string;
  bindings: JsonValue;
  binding_paths: JsonValue;
  resource_keys: JsonValue;
  preimage_kind?: string;
  preimage_blob_id?: string;
  preimage_bytes?: number;
  preimage_rows?: number;
  preimage_truncated: number;
  preimage_meta?: JsonValue;
  status: string;
  compensation_state: string;
  compensator_id?: string;
  capture_fidelity: string;
  capture_interceptor: string;
  capture_warnings?: JsonValue;
  leak: string;
  cascade_risk: string;
  compensable_until?: string;
  opened_at: string;
  closed_at?: string;
  duration_ms?: number;
  redactions?: JsonValue;
  sealed: number;
  seal_hash?: string;
}

export interface ProjectionDivergence {
  entity: "saga" | "effect";
  id: string;
  field: string;
  rebuilt: JsonValue;
  stored: JsonValue | null;
}

export interface RebuildOpts {
  asOf?: string;
}

export interface LeaseAcquireOpts {
  ttlMs?: number;
}

export const ANCHOR_SAGA_ID = "sag__anchors";

export const LEDGER_TABLE_NAMES = [
  "receipt_events",
  "sagas",
  "effects",
  "plans",
  "attempts",
  "leases",
  "blobs",
  "compensators",
  "escalations",
  "anchors",
] as const;

export const BLOB_INLINE_MAX = 256 * 1024;

export interface CompensatorRow {
  id: string;
  manifest: JsonValue;
  source: string;
  match_kind: string;
  specificity: number;
  signature?: string;
  registered_at: string;
  disabled: number;
}

export interface Ledger {
  readonly kind: LedgerKind;
  append(event: ReceiptEvent, opts?: AppendOpts): Promise<void>;
  readSaga(sagaId: string): Promise<ReceiptEvent[]>;
  readAll(): Promise<ReceiptEvent[]>;
  getSaga(sagaId: string): Promise<Saga | undefined>;
  upsertSaga(saga: Saga): Promise<void>;
  getEffect(effectId: string): Promise<EffectProjection | undefined>;
  upsertEffect(effect: EffectProjection): Promise<void>;
  listEffects(sagaId: string): Promise<EffectProjection[]>;
  appendAttempt(row: AttemptRecord): Promise<void>;
  getAttempt(attemptId: string): Promise<AttemptRecord | undefined>;
  getAttemptByIdempotencyKey(key: string): Promise<AttemptRecord | undefined>;
  updateAttempt(row: AttemptRecord): Promise<void>;
  acquireLease(
    resourceKey: string,
    holder: string,
    opts?: LeaseAcquireOpts,
  ): Promise<{ fence: number; expires_at: string }>;
  releaseLease(resourceKey: string, holder: string, fence: number): Promise<void>;
  getLease(resourceKey: string): Promise<LeaseRecord | undefined>;
  renewLease(
    resourceKey: string,
    holder: string,
    fence: number,
    opts?: LeaseAcquireOpts,
  ): Promise<{ expires_at: string }>;
  putPlan(plan: CompensationPlan): Promise<void>;
  getPlan(planId: string): Promise<CompensationPlan | undefined>;
  putBlob(bytes: Uint8Array): Promise<string>;
  getBlob(blobId: string): Promise<Uint8Array | null>;
  appendAnchor(row: AnchorRecord): Promise<void>;
  listAnchors(): Promise<AnchorRecord[]>;
  rebuildProjections(sagaId: string, opts?: RebuildOpts): Promise<ProjectionDivergence[]>;
  tickAnchor(): Promise<void>;
  maybeTickAnchor(): Promise<boolean>;
  listCompensators(): Promise<CompensatorRow[]>;
  upsertCompensator(row: CompensatorRow): Promise<void>;
  getCompensator(id: string): Promise<CompensatorRow | undefined>;
  close(): Promise<void>;
}

export interface LedgerHooks {
  persistEvent?(ev: ReceiptEvent, fsync: boolean): Promise<void>;
  persistAttempt?(row: AttemptRecord, fsync: boolean): Promise<void>;
  persistBlob?(blobId: string, bytes: Uint8Array): Promise<void>;
  loadBlob?(blobId: string): Promise<Uint8Array | null>;
  persistLease?(row: LeaseRecord | null, resourceKey: string): Promise<void>;
  persistAnchor?(row: AnchorRecord): Promise<void>;
  persistSaga?(saga: Saga): Promise<void>;
  persistEffect?(effect: EffectProjection): Promise<void>;
  deleteEffects?(sagaId: string): Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export function rejectFsyncNever(kind: LedgerKind, fsync: FsyncMode | undefined): void {
  if (fsync === "never" && kind !== "memory") {
    throw new VekRevertError("VR2002", "fsync:never is only allowed for memory ledgers");
  }
}

export function isWalEvent(type: string): boolean {
  return type === "effect_opened";
}

export function jsonText(value: JsonValue): string {
  return canonicalize(value);
}

export function parseJson(text: string | null | undefined, fallback: JsonValue): JsonValue {
  if (text == null || text === "") return fallback;
  return JSON.parse(text) as JsonValue;
}

export function isoNow(clock: LedgerClock): string {
  return clock().toISOString();
}

export function emptySaga(ev: ReceiptEvent): Saga {
  return {
    saga_id: ev.saga_id,
    status: "open",
    next_seq: 1,
    opened_at: ev.ts,
    chain_head: genesisHash(ev.saga_id),
    chain_len: 0,
  };
}

export function emptyEffect(ev: ReceiptEvent, payload: Record<string, unknown>): EffectProjection {
  const action = (payload.action ?? {}) as Record<string, unknown>;
  const preimage = payload.preimage as Record<string, unknown> | undefined;
  return {
    effect_id: String(payload.effect_id ?? ev.effect_id ?? ""),
    saga_id: ev.saga_id,
    seq: Number(payload.seq ?? 0),
    action_kind: String(action.kind ?? "sdk_fn"),
    action_name: String(action.name ?? "unknown"),
    action_target: action.target != null ? String(action.target) : undefined,
    locality: String(action.locality ?? "unknown"),
    tier: String(payload.tier ?? "T4"),
    restore_sibling_of: payload.restore_sibling_of != null ? String(payload.restore_sibling_of) : undefined,
    classification: (payload.classification as JsonValue) ?? {},
    args_observed: (payload.args_observed as JsonValue) ?? {},
    args_hash: String(payload.args_hash ?? ""),
    args_commitments: (payload.args_commitments as JsonValue | undefined) ?? undefined,
    intent_key: String(payload.intent_key ?? ""),
    bindings: {},
    binding_paths: {},
    resource_keys: [],
    preimage_kind: preimage?.kind != null ? String(preimage.kind) : undefined,
    preimage_blob_id: preimage?.blob_id != null ? String(preimage.blob_id) : undefined,
    preimage_bytes: typeof preimage?.bytes === "number" ? preimage.bytes : undefined,
    preimage_rows: typeof preimage?.rows === "number" ? preimage.rows : undefined,
    preimage_truncated: preimage?.truncated ? 1 : 0,
    preimage_meta: (preimage?.meta as JsonValue | undefined) ?? undefined,
    status: "opened",
    compensation_state: "available",
    capture_fidelity: "full",
    capture_interceptor: "unknown",
    leak: "none",
    cascade_risk: "none",
    opened_at: payload.opened_at != null ? String(payload.opened_at) : ev.ts,
    sealed: 0,
  };
}

function asRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

function setCompState(effect: EffectProjection, state: string): void {
  effect.compensation_state = state;
}

/** Fold one receipt event into rebuildable projections. Never mutates sealed receipt fields. */
export function applyEventToProjections(
  sagas: Map<string, Saga>,
  effects: Map<string, EffectProjection>,
  anchors: AnchorRecord[],
  ev: ReceiptEvent,
): void {
  let saga = sagas.get(ev.saga_id);
  if (!saga) {
    saga = emptySaga(ev);
    sagas.set(ev.saga_id, saga);
  }
  saga.chain_head = ev.hash;
  saga.chain_len += 1;

  const p = asRecord(ev.payload);

  switch (ev.type) {
    case "saga_opened": {
      if (p.key != null) saga.key = String(p.key);
      if (p.agent_id != null) saga.agent_id = String(p.agent_id);
      saga.status = "open";
      saga.opened_at = ev.ts;
      break;
    }
    case "effect_opened": {
      const eff = emptyEffect(ev, p);
      if (ev.effect_id && !eff.effect_id) eff.effect_id = ev.effect_id;
      effects.set(eff.effect_id, eff);
      saga.next_seq = Math.max(saga.next_seq, eff.seq + 1);
      break;
    }
    case "effect_closed": {
      const id = ev.effect_id ?? String(p.effect_id ?? "");
      const eff = effects.get(id);
      if (!eff) break;
      if (p.status != null) eff.status = String(p.status);
      if (p.result_hash != null) eff.result_hash = String(p.result_hash);
      if (p.bindings != null) eff.bindings = p.bindings as JsonValue;
      if (p.resource_keys != null) eff.resource_keys = p.resource_keys as JsonValue;
      if (p.duration_ms != null) eff.duration_ms = Number(p.duration_ms);
      if (p.seal_hash != null) {
        eff.seal_hash = String(p.seal_hash);
        eff.sealed = 1;
      }
      if (p.result_observed != null) eff.result_observed = p.result_observed as JsonValue;
      eff.closed_at = ev.ts;
      break;
    }
    case "effect_in_doubt": {
      const id = ev.effect_id ?? String(p.effect_id ?? "");
      const eff = effects.get(id);
      if (eff) eff.status = "in_doubt";
      break;
    }
    case "effect_probed": {
      const id = ev.effect_id ?? String(p.effect_id ?? "");
      const eff = effects.get(id);
      if (!eff) break;
      const result = String(p.probe_result ?? "");
      if (result === "landed") eff.status = "landed";
      else if (result === "not_landed") {
        eff.status = "abandoned";
        setCompState(eff, "none_required");
      }
      break;
    }
    case "effect_duplicate_suspected": {
      const id = ev.effect_id ?? String(p.effect_id ?? "");
      const eff = effects.get(id);
      if (eff && p.restore_sibling_of != null) eff.restore_sibling_of = String(p.restore_sibling_of);
      break;
    }
    case "capture_degraded": {
      const id = ev.effect_id ?? String(p.effect_id ?? "");
      const eff = effects.get(id);
      if (eff) {
        eff.capture_fidelity = String(p.fidelity ?? "degraded");
        if (p.warnings != null) eff.capture_warnings = p.warnings as JsonValue;
      }
      break;
    }
    case "compensation_unavailable": {
      const id = ev.effect_id ?? String(p.effect_id ?? "");
      const eff = effects.get(id);
      if (eff) setCompState(eff, "unavailable");
      break;
    }
    case "compensation_planned": {
      const id = ev.effect_id ?? String(p.effect_id ?? "");
      const eff = effects.get(id);
      if (eff) setCompState(eff, "planned");
      break;
    }
    case "compensation_verified": {
      const id = ev.effect_id ?? String(p.effect_id ?? "");
      const eff = effects.get(id);
      if (eff) setCompState(eff, "verified");
      break;
    }
    case "compensation_executed": {
      const id = ev.effect_id ?? String(p.effect_id ?? "");
      const eff = effects.get(id);
      if (eff) setCompState(eff, "compensated");
      break;
    }
    case "compensation_failed": {
      const id = ev.effect_id ?? String(p.effect_id ?? "");
      const eff = effects.get(id);
      if (eff) setCompState(eff, "failed");
      break;
    }
    case "compensation_skipped": {
      const id = ev.effect_id ?? String(p.effect_id ?? "");
      const eff = effects.get(id);
      if (!eff) break;
      const reason = String(p.reason ?? "");
      if (reason === "t1") setCompState(eff, "none_required");
      else if (reason === "superseded") setCompState(eff, "superseded");
      else if (reason === "abandoned") {
        setCompState(eff, "none_required");
        eff.status = "abandoned";
      } else setCompState(eff, "compensated");
      break;
    }
    case "escalation_raised": {
      const id = ev.effect_id ?? String(p.effect_id ?? "");
      const eff = effects.get(id);
      if (eff) setCompState(eff, "escalated");
      break;
    }
    case "escalation_resolved": {
      const id = ev.effect_id ?? String(p.effect_id ?? "");
      const eff = effects.get(id);
      if (eff) setCompState(eff, "manually_resolved");
      break;
    }
    case "saga_undone": {
      const st = String(p.status ?? "undone");
      saga.status =
        st === "partially_undone" || st === "failed" || st === "undone" || st === "undoing"
          ? (st as Saga["status"])
          : "undone";
      saga.closed_at = ev.ts;
      break;
    }
    case "ledger_anchored": {
      const seq = Number(p.anchor_seq ?? 0);
      if (!anchors.some((a) => a.anchor_seq === seq)) {
        anchors.push({
          anchor_seq: seq,
          merkle_root: String(p.merkle_root ?? ""),
          saga_heads: (p.saga_heads as AnchorRecord["saga_heads"]) ?? [],
          prev_anchor_hash: String(p.prev_anchor_hash ?? ""),
          hash: ev.hash,
          sig: ev.sig,
          anchored_at: String(p.anchored_at ?? ev.ts),
        });
      }
      break;
    }
    default:
      break;
  }
}

export function foldEvents(events: ReceiptEvent[]): {
  sagas: Map<string, Saga>;
  effects: Map<string, EffectProjection>;
  anchors: AnchorRecord[];
} {
  const sagas = new Map<string, Saga>();
  const effects = new Map<string, EffectProjection>();
  const anchors: AnchorRecord[] = [];
  for (const ev of events) applyEventToProjections(sagas, effects, anchors, ev);
  return { sagas, effects, anchors };
}

function snapshot(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function fieldDiffs(
  entity: "saga" | "effect",
  id: string,
  rebuilt: Record<string, unknown>,
  stored: Record<string, unknown> | undefined,
): ProjectionDivergence[] {
  const out: ProjectionDivergence[] = [];
  if (!stored) {
    out.push({ entity, id, field: "(missing)", rebuilt: snapshot(rebuilt), stored: null });
    return out;
  }
  const keys = new Set([...Object.keys(rebuilt), ...Object.keys(stored)]);
  for (const field of keys) {
    const a = canonicalize(snapshot(rebuilt[field] ?? null));
    const b = canonicalize(snapshot(stored[field] ?? null));
    if (a !== b) {
      out.push({
        entity,
        id,
        field,
        rebuilt: snapshot(rebuilt[field] ?? null),
        stored: snapshot(stored[field] ?? null),
      });
    }
  }
  return out;
}

export function diffProjections(
  rebuiltSagas: Map<string, Saga>,
  rebuiltEffects: Map<string, EffectProjection>,
  storedSagas: Map<string, Saga>,
  storedEffects: Map<string, EffectProjection>,
  sagaId: string,
): ProjectionDivergence[] {
  const out: ProjectionDivergence[] = [];
  const rs = rebuiltSagas.get(sagaId);
  const ss = storedSagas.get(sagaId);
  if (rs) out.push(...fieldDiffs("saga", sagaId, rs as unknown as Record<string, unknown>, ss as unknown as Record<string, unknown> | undefined));
  else if (ss) out.push({ entity: "saga", id: sagaId, field: "(extra)", rebuilt: null, stored: snapshot(ss) });

  const rebuiltIds = [...rebuiltEffects.values()].filter((e) => e.saga_id === sagaId).map((e) => e.effect_id);
  const storedIds = [...storedEffects.values()].filter((e) => e.saga_id === sagaId).map((e) => e.effect_id);
  for (const id of rebuiltIds) {
    const r = rebuiltEffects.get(id)!;
    const s = storedEffects.get(id);
    out.push(...fieldDiffs("effect", id, r as unknown as Record<string, unknown>, s as unknown as Record<string, unknown> | undefined));
  }
  for (const id of storedIds) {
    if (!rebuiltEffects.has(id)) {
      out.push({ entity: "effect", id, field: "(extra)", rebuilt: null, stored: snapshot(storedEffects.get(id)) });
    }
  }
  return out;
}

export function eventToColumns(ev: ReceiptEvent): Record<string, unknown> {
  return {
    id: ev.id,
    saga_id: ev.saga_id,
    chain_seq: ev.chain_seq,
    type: ev.type,
    ts: ev.ts,
    effect_id: ev.effect_id ?? null,
    actor_kind: ev.actor.kind,
    actor_id: ev.actor.id,
    payload: jsonText(ev.payload as unknown as JsonValue),
    prev_hash: ev.prev_hash,
    hash: ev.hash,
    sig: ev.sig ?? null,
  };
}

export function columnsToEvent(row: Record<string, unknown>): ReceiptEvent {
  const payload = parseJson(row.payload as string, {});
  const ev: ReceiptEvent = {
    v: "vekrevert/v1",
    id: String(row.id),
    type: String(row.type) as ReceiptEvent["type"],
    ts: String(row.ts),
    saga_id: String(row.saga_id),
    chain_seq: Number(row.chain_seq),
    actor: { kind: row.actor_kind as ReceiptEvent["actor"]["kind"], id: String(row.actor_id) },
    payload: payload as ReceiptEvent["payload"],
    prev_hash: String(row.prev_hash),
    hash: String(row.hash),
  };
  if (row.effect_id) ev.effect_id = String(row.effect_id);
  if (row.sig) ev.sig = String(row.sig);
  return ev;
}

export function rowToAttempt(row: Record<string, unknown>): AttemptRecord {
  return {
    attempt_id: String(row.attempt_id),
    idempotency_key: String(row.idempotency_key),
    effect_id: String(row.effect_id),
    plan_id: String(row.plan_id),
    step_index: Number(row.step_index),
    fence: Number(row.fence),
    state: String(row.state) as AttemptRecord["state"],
    started_at: String(row.started_at),
    finished_at: row.finished_at != null ? String(row.finished_at) : undefined,
    error_code: row.error_code != null ? String(row.error_code) : undefined,
    response_hash: row.response_hash != null ? String(row.response_hash) : undefined,
  };
}

export function rowToLease(row: Record<string, unknown>): LeaseRecord {
  return {
    resource_key: String(row.resource_key),
    holder: String(row.holder),
    acquired_at: String(row.acquired_at),
    expires_at: String(row.expires_at),
    fence: Number(row.fence),
  };
}

export function rowToPlan(row: Record<string, unknown>): CompensationPlan {
  const plan: CompensationPlan = {
    v: "vekrevert/v1",
    plan_id: String(row.plan_id),
    effect_id: String(row.effect_id),
    saga_id: String(row.saga_id),
    compensator_id: String(row.compensator_id),
    origin: String(row.origin) as CompensationPlan["origin"],
    steps: parseJson(row.steps as string, []) as CompensationPlan["steps"],
    plan_hash: String(row.plan_hash),
    postconditions: parseJson(row.postconditions as string, []) as unknown as CompensationPlan["postconditions"],
    reversal_completeness: String(row.reversal_completeness) as CompensationPlan["reversal_completeness"],
    leak: String(row.leak) as CompensationPlan["leak"],
    cascade_risk: String(row.cascade_risk) as CompensationPlan["cascade_risk"],
    summary: String(row.summary ?? ""),
    created_at: String(row.created_at),
  };
  if (row.verification != null) {
    plan.verification = parseJson(row.verification as string, {}) as unknown as CompensationPlan["verification"];
  }
  return plan;
}

export function rowToSaga(row: Record<string, unknown>): Saga {
  const saga: Saga = {
    saga_id: String(row.saga_id),
    status: String(row.status) as Saga["status"],
    next_seq: Number(row.next_seq),
    opened_at: String(row.opened_at),
    chain_head: String(row.chain_head),
    chain_len: Number(row.chain_len),
  };
  if (row.key != null) saga.key = String(row.key);
  if (row.agent_id != null) saga.agent_id = String(row.agent_id);
  if (row.closed_at != null) saga.closed_at = String(row.closed_at);
  return saga;
}

export function rowToEffect(row: Record<string, unknown>): EffectProjection {
  return {
    effect_id: String(row.effect_id),
    saga_id: String(row.saga_id),
    seq: Number(row.seq),
    compensation_of: row.compensation_of != null ? String(row.compensation_of) : undefined,
    restore_sibling_of: row.restore_sibling_of != null ? String(row.restore_sibling_of) : undefined,
    parent_effect_id: row.parent_effect_id != null ? String(row.parent_effect_id) : undefined,
    action_kind: String(row.action_kind),
    action_name: String(row.action_name),
    action_target: row.action_target != null ? String(row.action_target) : undefined,
    locality: String(row.locality),
    tier: String(row.tier),
    classification: parseJson(row.classification as string, {}),
    args_observed: parseJson(row.args_observed as string, {}),
    args_hash: String(row.args_hash),
    args_commitments: row.args_commitments != null ? parseJson(row.args_commitments as string, {}) : undefined,
    intent_key: String(row.intent_key),
    result_observed: row.result_observed != null ? parseJson(row.result_observed as string, {}) : undefined,
    result_hash: row.result_hash != null ? String(row.result_hash) : undefined,
    bindings: parseJson(row.bindings as string, {}),
    binding_paths: parseJson(row.binding_paths as string, {}),
    resource_keys: parseJson(row.resource_keys as string, []),
    preimage_kind: row.preimage_kind != null ? String(row.preimage_kind) : undefined,
    preimage_blob_id: row.preimage_blob_id != null ? String(row.preimage_blob_id) : undefined,
    preimage_bytes: row.preimage_bytes != null ? Number(row.preimage_bytes) : undefined,
    preimage_rows: row.preimage_rows != null ? Number(row.preimage_rows) : undefined,
    preimage_truncated: Number(row.preimage_truncated ?? 0),
    preimage_meta: row.preimage_meta != null ? parseJson(row.preimage_meta as string, {}) : undefined,
    status: String(row.status),
    compensation_state: String(row.compensation_state),
    compensator_id: row.compensator_id != null ? String(row.compensator_id) : undefined,
    capture_fidelity: String(row.capture_fidelity),
    capture_interceptor: String(row.capture_interceptor),
    capture_warnings: row.capture_warnings != null ? parseJson(row.capture_warnings as string, []) : undefined,
    leak: String(row.leak),
    cascade_risk: String(row.cascade_risk),
    compensable_until: row.compensable_until != null ? String(row.compensable_until) : undefined,
    opened_at: String(row.opened_at),
    closed_at: row.closed_at != null ? String(row.closed_at) : undefined,
    duration_ms: row.duration_ms != null ? Number(row.duration_ms) : undefined,
    redactions: row.redactions != null ? parseJson(row.redactions as string, []) : undefined,
    sealed: Number(row.sealed ?? 0),
    seal_hash: row.seal_hash != null ? String(row.seal_hash) : undefined,
  };
}

function rowToCompensator(row: Record<string, unknown>): CompensatorRow {
  return {
    id: String(row.id),
    manifest: parseJson(row.manifest as string, {}),
    source: String(row.source),
    match_kind: String(row.match_kind),
    specificity: Number(row.specificity),
    signature: row.signature != null ? String(row.signature) : undefined,
    registered_at: String(row.registered_at),
    disabled: Number(row.disabled ?? 0),
  };
}

export function effectBindValues(e: EffectProjection): unknown[] {
  return [
    e.effect_id,
    e.saga_id,
    e.seq,
    e.compensation_of ?? null,
    e.restore_sibling_of ?? null,
    e.parent_effect_id ?? null,
    e.action_kind,
    e.action_name,
    e.action_target ?? null,
    e.locality,
    e.tier,
    jsonText(e.classification),
    jsonText(e.args_observed),
    e.args_hash,
    e.args_commitments != null ? jsonText(e.args_commitments) : null,
    e.intent_key,
    e.result_observed != null ? jsonText(e.result_observed) : null,
    e.result_hash ?? null,
    jsonText(e.bindings),
    jsonText(e.binding_paths),
    jsonText(e.resource_keys),
    e.preimage_kind ?? null,
    e.preimage_blob_id ?? null,
    e.preimage_bytes ?? null,
    e.preimage_rows ?? null,
    e.preimage_truncated,
    e.preimage_meta != null ? jsonText(e.preimage_meta) : null,
    e.status,
    e.compensation_state,
    e.compensator_id ?? null,
    e.capture_fidelity,
    e.capture_interceptor,
    e.capture_warnings != null ? jsonText(e.capture_warnings) : null,
    e.leak,
    e.cascade_risk,
    e.compensable_until ?? null,
    e.opened_at,
    e.closed_at ?? null,
    e.duration_ms ?? null,
    e.redactions != null ? jsonText(e.redactions) : null,
    e.sealed,
    e.seal_hash ?? null,
  ];
}

export const EFFECT_COLUMNS = [
  "effect_id",
  "saga_id",
  "seq",
  "compensation_of",
  "restore_sibling_of",
  "parent_effect_id",
  "action_kind",
  "action_name",
  "action_target",
  "locality",
  "tier",
  "classification",
  "args_observed",
  "args_hash",
  "args_commitments",
  "intent_key",
  "result_observed",
  "result_hash",
  "bindings",
  "binding_paths",
  "resource_keys",
  "preimage_kind",
  "preimage_blob_id",
  "preimage_bytes",
  "preimage_rows",
  "preimage_truncated",
  "preimage_meta",
  "status",
  "compensation_state",
  "compensator_id",
  "capture_fidelity",
  "capture_interceptor",
  "capture_warnings",
  "leak",
  "cascade_risk",
  "compensable_until",
  "opened_at",
  "closed_at",
  "duration_ms",
  "redactions",
  "sealed",
  "seal_hash",
] as const;

export function ph(kind: "sqlite" | "postgres", n: number): string {
  return kind === "postgres" ? `$${n}` : "?";
}

export function phList(kind: "sqlite" | "postgres", count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => ph(kind, start + i)).join(", ");
}

export function wrapSqliteError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("VR2015")) throw new VekRevertError("VR2015", msg);
  throw err instanceof Error ? err : new Error(msg);
}

export function blobIdFor(bytes: Uint8Array): string {
  return `blob_sha256:${sha256Hex(bytes)}`;
}

export function createMemoryLedger(
  opts: LedgerOpenOptions = {},
  initial: ReceiptEvent[] = [],
  hooks: LedgerHooks = {},
  kind: LedgerKind = "memory",
): Ledger {
  rejectFsyncNever(kind, opts.fsync);
  const fsyncMode: FsyncMode = opts.fsync ?? (kind === "memory" ? "never" : DEFAULT_LEDGER_OPTS.fsync);
  rejectFsyncNever(kind, fsyncMode);
  const fsyncIntervalMs = opts.fsyncIntervalMs ?? DEFAULT_LEDGER_OPTS.fsyncIntervalMs;
  const anchorEvery = opts.anchorEvery ?? DEFAULT_LEDGER_OPTS.anchorEvery;
  const anchorIntervalMs = opts.anchorIntervalMs ?? DEFAULT_LEDGER_OPTS.anchorIntervalMs;
  const clock: LedgerClock = opts.clock ?? (() => new Date());

  const events: ReceiptEvent[] = [];
  const sagas = new Map<string, Saga>();
  const effects = new Map<string, EffectProjection>();
  const attempts = new Map<string, AttemptRecord>();
  const attemptsByKey = new Map<string, string>();
  const leases = new Map<string, LeaseRecord>();
  const plans = new Map<string, CompensationPlan>();
  const blobs = new Map<string, BlobRecord & { data: Uint8Array }>();
  const anchors: AnchorRecord[] = [];
  const compensators = new Map<string, CompensatorRow>();

  let lastFsyncMs = clock().getTime();
  let lastAnchorCount = 0;
  let lastAnchorMs = clock().getTime();
  let anchoring = false;
  let closed = false;

  for (const ev of initial) {
    events.push(ev);
    applyEventToProjections(sagas, effects, anchors, ev);
  }
  const lastAnchorEv = [...initial].reverse().find((e) => e.type === "ledger_anchored");
  if (lastAnchorEv) {
    lastAnchorCount = initial.indexOf(lastAnchorEv) + 1;
    lastAnchorMs = Date.parse(lastAnchorEv.ts);
  } else {
    lastAnchorCount = 0;
    lastAnchorMs = clock().getTime();
  }

  function wantFsync(mandatory: boolean, requested?: boolean): boolean {
    if (kind === "memory" || fsyncMode === "never") return false;
    if (mandatory || requested === true) return true;
    if (requested === false && !mandatory) {
      if (fsyncMode === "always") return true;
      return clock().getTime() - lastFsyncMs >= fsyncIntervalMs;
    }
    if (fsyncMode === "always") return true;
    return clock().getTime() - lastFsyncMs >= fsyncIntervalMs;
  }

  function markFsync(did: boolean): void {
    if (did) lastFsyncMs = clock().getTime();
  }

  const api: Ledger = {
    kind,
    async append(event, appendOpts) {
      if (closed) throw new VekRevertError("VR2002", "ledger is closed");
      const mandatory = isWalEvent(event.type);
      const doFsync = wantFsync(mandatory, appendOpts?.fsync);
      if (hooks.persistEvent) await hooks.persistEvent(event, doFsync);
      events.push(event);
      applyEventToProjections(sagas, effects, anchors, event);
      if (hooks.persistSaga) {
        const s = sagas.get(event.saga_id);
        if (s) await hooks.persistSaga(s);
      }
      if (hooks.persistEffect && event.effect_id) {
        const e = effects.get(event.effect_id);
        if (e) await hooks.persistEffect(e);
      } else if (hooks.persistEffect) {
        const p = asRecord(event.payload);
        const eid = event.effect_id ?? (p.effect_id != null ? String(p.effect_id) : "");
        if (eid) {
          const e = effects.get(eid);
          if (e) await hooks.persistEffect(e);
        }
      }
      if (event.type === "ledger_anchored" && hooks.persistAnchor) {
        const a = anchors.find((x) => x.hash === event.hash);
        if (a) await hooks.persistAnchor(a);
      }
      markFsync(doFsync);
      await api.maybeTickAnchor();
    },
    async readSaga(sagaId) {
      return events.filter((e) => e.saga_id === sagaId);
    },
    async readAll() {
      return [...events];
    },
    async getSaga(sagaId) {
      return sagas.get(sagaId);
    },
    async upsertSaga(saga) {
      sagas.set(saga.saga_id, { ...saga });
      if (hooks.persistSaga) await hooks.persistSaga(saga);
    },
    async getEffect(effectId) {
      return effects.get(effectId);
    },
    async upsertEffect(effect) {
      effects.set(effect.effect_id, { ...effect });
      if (hooks.persistEffect) await hooks.persistEffect(effect);
    },
    async listEffects(sagaId) {
      return [...effects.values()].filter((e) => e.saga_id === sagaId).sort((a, b) => a.seq - b.seq);
    },
    async appendAttempt(row) {
      if (attemptsByKey.has(row.idempotency_key)) {
        throw new DuplicateAttemptError(row.idempotency_key);
      }
      attemptsByKey.set(row.idempotency_key, row.attempt_id);
      attempts.set(row.attempt_id, { ...row });
      if (hooks.persistAttempt) await hooks.persistAttempt(row, true);
      markFsync(true);
    },
    async getAttempt(attemptId) {
      return attempts.get(attemptId);
    },
    async getAttemptByIdempotencyKey(key) {
      const id = attemptsByKey.get(key);
      return id ? attempts.get(id) : undefined;
    },
    async updateAttempt(row) {
      attempts.set(row.attempt_id, { ...row });
      attemptsByKey.set(row.idempotency_key, row.attempt_id);
      if (hooks.persistAttempt) await hooks.persistAttempt(row, true);
      markFsync(true);
    },
    async acquireLease(resourceKey, holder, leaseOpts) {
      const now = clock();
      const ttl = leaseOpts?.ttlMs ?? DEFAULT_LEASE.ttlMs;
      const nowIso = now.toISOString();
      const existing = leases.get(resourceKey);
      if (existing && existing.expires_at > nowIso && existing.holder !== holder) {
        throw new VekRevertError("VR5005");
      }
      const fence = existing ? existing.fence + 1 : 1;
      const expires_at = new Date(now.getTime() + ttl).toISOString();
      const rec: LeaseRecord = { resource_key: resourceKey, holder, acquired_at: nowIso, expires_at, fence };
      leases.set(resourceKey, rec);
      if (hooks.persistLease) await hooks.persistLease(rec, resourceKey);
      return { fence, expires_at };
    },
    async releaseLease(resourceKey, holder, fence) {
      const existing = leases.get(resourceKey);
      if (!existing) return;
      if (existing.holder !== holder || existing.fence !== fence) {
        throw new VekRevertError("VR5010");
      }
      leases.delete(resourceKey);
      if (hooks.persistLease) await hooks.persistLease(null, resourceKey);
    },
    async getLease(resourceKey) {
      return leases.get(resourceKey);
    },
    async renewLease(resourceKey, holder, fence, leaseOpts) {
      const existing = leases.get(resourceKey);
      if (!existing || existing.holder !== holder || existing.fence !== fence) {
        throw new VekRevertError("VR5010");
      }
      const now = clock();
      const ttl = leaseOpts?.ttlMs ?? DEFAULT_LEASE.ttlMs;
      const expires_at = new Date(now.getTime() + ttl).toISOString();
      const rec: LeaseRecord = { ...existing, expires_at };
      leases.set(resourceKey, rec);
      if (hooks.persistLease) await hooks.persistLease(rec, resourceKey);
      return { expires_at };
    },
    async putPlan(plan) {
      plans.set(plan.plan_id, { ...plan });
    },
    async getPlan(planId) {
      return plans.get(planId);
    },
    async putBlob(bytes) {
      const blob_id = blobIdFor(bytes);
      const existing = blobs.get(blob_id);
      if (existing) {
        existing.refcount += 1;
        return blob_id;
      }
      if (hooks.persistBlob) await hooks.persistBlob(blob_id, bytes);
      blobs.set(blob_id, {
        blob_id,
        bytes: bytes.byteLength,
        created_at: isoNow(clock),
        refcount: 1,
        storage: bytes.byteLength > BLOB_INLINE_MAX ? "file" : "inline",
        data: bytes,
      });
      return blob_id;
    },
    async getBlob(blobId) {
      if (hooks.loadBlob) {
        const loaded = await hooks.loadBlob(blobId);
        if (loaded) return loaded;
      }
      return blobs.get(blobId)?.data ?? null;
    },
    async appendAnchor(row) {
      if (!anchors.some((a) => a.anchor_seq === row.anchor_seq)) anchors.push(row);
      if (hooks.persistAnchor) await hooks.persistAnchor(row);
    },
    async listAnchors() {
      return [...anchors].sort((a, b) => a.anchor_seq - b.anchor_seq);
    },
    async rebuildProjections(sagaId, rebuildOpts) {
      const slice = events.filter((e) => e.saga_id === sagaId && (!rebuildOpts?.asOf || e.ts <= rebuildOpts.asOf));
      const folded = foldEvents(slice);
      const storedSagas = new Map<string, Saga>();
      const storedEffects = new Map<string, EffectProjection>();
      const s = sagas.get(sagaId);
      if (s) storedSagas.set(sagaId, { ...s });
      for (const e of effects.values()) {
        if (e.saga_id === sagaId) storedEffects.set(e.effect_id, { ...e });
      }
      const divergences = diffProjections(folded.sagas, folded.effects, storedSagas, storedEffects, sagaId);
      const rebuiltSaga = folded.sagas.get(sagaId);
      if (rebuiltSaga) {
        sagas.set(sagaId, rebuiltSaga);
        if (hooks.persistSaga) await hooks.persistSaga(rebuiltSaga);
      }
      if (hooks.deleteEffects) await hooks.deleteEffects(sagaId);
      for (const [id, e] of [...effects.entries()]) {
        if (e.saga_id === sagaId) effects.delete(id);
      }
      for (const e of folded.effects.values()) {
        effects.set(e.effect_id, e);
        if (hooks.persistEffect) await hooks.persistEffect(e);
      }
      return divergences;
    },
    async tickAnchor() {
      await fireAnchor();
    },
    async maybeTickAnchor() {
      if (anchoring) return false;
      const now = clock().getTime();
      const dueCount = events.length - lastAnchorCount >= anchorEvery;
      const dueTime = now - lastAnchorMs >= anchorIntervalMs;
      if (!dueCount && !dueTime) return false;
      const userSagas = [...sagas.values()].filter((s) => s.saga_id !== ANCHOR_SAGA_ID);
      if (userSagas.length === 0) return false;
      await fireAnchor();
      return true;
    },
    async listCompensators() {
      return [...compensators.values()];
    },
    async upsertCompensator(row) {
      compensators.set(row.id, { ...row });
    },
    async getCompensator(id) {
      return compensators.get(id);
    },
    async close() {
      closed = true;
      if (hooks.flush) await hooks.flush();
      if (hooks.close) await hooks.close();
    },
  };

  async function fireAnchor(): Promise<void> {
    if (anchoring) return;
    anchoring = true;
    try {
      const heads = [...sagas.values()]
        .filter((s) => s.saga_id !== ANCHOR_SAGA_ID)
        .map((s) => ({ saga_id: s.saga_id, chain_head: s.chain_head, chain_len: s.chain_len }))
        .sort((a, b) => (a.saga_id < b.saga_id ? -1 : a.saga_id > b.saga_id ? 1 : 0));
      const merkle_root = merkleRoot(heads.map((h) => ({ saga_id: h.saga_id, chain_head: h.chain_head })));
      const prev = anchors.length ? anchors[anchors.length - 1]! : undefined;
      const prev_anchor_hash = prev?.hash ?? genesisHash(ANCHOR_SAGA_ID);
      const anchor_seq = (prev?.anchor_seq ?? 0) + 1;
      const anchored_at = isoNow(clock);
      const prior = events.filter((e) => e.saga_id === ANCHOR_SAGA_ID);
      const prev_hash = prior.length ? prior[prior.length - 1]!.hash : genesisHash(ANCHOR_SAGA_ID);
      const chain_seq = prior.length + 1;
      const body = {
        v: "vekrevert/v1" as const,
        id: newEventId(clock().getTime()),
        type: "ledger_anchored" as const,
        ts: anchored_at,
        saga_id: ANCHOR_SAGA_ID,
        chain_seq,
        actor: { kind: "system" as const, id: "vekrevert" },
        payload: {
          anchor_seq,
          merkle_root,
          saga_heads: heads,
          prev_anchor_hash,
          anchored_at,
        },
        prev_hash,
      };
      const chained = chainEvent(body, prev_hash);
      await api.append(chained as ReceiptEvent);
      lastAnchorCount = events.length;
      lastAnchorMs = clock().getTime();
    } finally {
      anchoring = false;
    }
  }

  return api;
}

export interface SqlAdapter {
  dialect: "sqlite" | "postgres";
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
  get(sql: string, params?: unknown[]): Promise<Record<string, unknown> | undefined>;
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  tx<T>(mode: "immediate" | "deferred", fn: () => Promise<T>): Promise<T>;
  durableFlush(): Promise<void>;
  close(): Promise<void>;
}

export function createSqlLedger(kind: "sqlite" | "postgres", adapter: SqlAdapter, opts: LedgerOpenOptions = {}): Ledger {
  rejectFsyncNever(kind, opts.fsync);
  const fsyncMode: FsyncMode = opts.fsync ?? DEFAULT_LEDGER_OPTS.fsync;
  rejectFsyncNever(kind, fsyncMode);
  const fsyncIntervalMs = opts.fsyncIntervalMs ?? DEFAULT_LEDGER_OPTS.fsyncIntervalMs;
  const anchorEvery = opts.anchorEvery ?? DEFAULT_LEDGER_OPTS.anchorEvery;
  const anchorIntervalMs = opts.anchorIntervalMs ?? DEFAULT_LEDGER_OPTS.anchorIntervalMs;
  const clock: LedgerClock = opts.clock ?? (() => new Date());
  const d = adapter.dialect;

  let lastFsyncMs = clock().getTime();
  let lastAnchorCount = 0;
  let lastAnchorMs = clock().getTime();
  let anchoring = false;
  let eventCount = 0;
  let closed = false;
  let bootstrapped = false;

  function wantFsync(mandatory: boolean, requested?: boolean): boolean {
    if (fsyncMode === "never") return false;
    if (mandatory || requested === true) return true;
    if (fsyncMode === "always") return true;
    return clock().getTime() - lastFsyncMs >= fsyncIntervalMs;
  }

  async function bootstrapCounts(): Promise<void> {
    if (bootstrapped) return;
    const row = await adapter.get(`SELECT COUNT(*) AS n FROM receipt_events`);
    eventCount = Number(row?.n ?? 0);
    const lastA = await adapter.get(`SELECT hash, anchored_at, anchor_seq FROM anchors ORDER BY anchor_seq DESC LIMIT 1`);
    if (lastA) {
      lastAnchorMs = Date.parse(String(lastA.anchored_at));
      lastAnchorCount = eventCount;
    } else {
      lastAnchorMs = clock().getTime();
      lastAnchorCount = 0;
    }
    bootstrapped = true;
  }

  async function insertEvent(event: ReceiptEvent, doFsync: boolean): Promise<void> {
    const c = eventToColumns(event);
    const sql = `INSERT INTO receipt_events (id, saga_id, chain_seq, type, ts, effect_id, actor_kind, actor_id, payload, prev_hash, hash, sig)
      VALUES (${phList(d, 12)})`;
    try {
      await adapter.run(sql, [
        c.id,
        c.saga_id,
        c.chain_seq,
        c.type,
        c.ts,
        c.effect_id,
        c.actor_kind,
        c.actor_id,
        c.payload,
        c.prev_hash,
        c.hash,
        c.sig,
      ]);
    } catch (err) {
      wrapSqliteError(err);
    }
    eventCount += 1;
    if (doFsync) {
      await adapter.durableFlush();
      lastFsyncMs = clock().getTime();
    }
  }

  const api: Ledger = {
    kind,
    async append(event, appendOpts) {
      if (closed) throw new VekRevertError("VR2002", "ledger is closed");
      await bootstrapCounts();
      const mandatory = isWalEvent(event.type);
      const doFsync = wantFsync(mandatory, appendOpts?.fsync);
      await insertEvent(event, doFsync);
      const sagas = new Map<string, Saga>();
      const effects = new Map<string, EffectProjection>();
      const anchors: AnchorRecord[] = [];
      const existing = await api.getSaga(event.saga_id);
      if (existing) sagas.set(event.saga_id, existing);
      for (const e of await api.listEffects(event.saga_id)) effects.set(e.effect_id, e);
      applyEventToProjections(sagas, effects, anchors, event);
      const saga = sagas.get(event.saga_id);
      if (saga) await api.upsertSaga(saga);
      const p = asRecord(event.payload);
      const eid = event.effect_id ?? (p.effect_id != null ? String(p.effect_id) : "");
      if (eid && effects.has(eid)) await api.upsertEffect(effects.get(eid)!);
      for (const a of anchors) await api.appendAnchor(a);
      await api.maybeTickAnchor();
    },
    async readSaga(sagaId) {
      const rows = await adapter.all(
        `SELECT * FROM receipt_events WHERE saga_id = ${ph(d, 1)} ORDER BY chain_seq ASC`,
        [sagaId],
      );
      return rows.map((r) => columnsToEvent(r));
    },
    async readAll() {
      const rows = await adapter.all(`SELECT * FROM receipt_events ORDER BY ts ASC, chain_seq ASC`);
      return rows.map((r) => columnsToEvent(r));
    },
    async getSaga(sagaId) {
      const row = await adapter.get(`SELECT * FROM sagas WHERE saga_id = ${ph(d, 1)}`, [sagaId]);
      return row ? rowToSaga(row) : undefined;
    },
    async upsertSaga(saga) {
      const sql = `INSERT INTO sagas (saga_id, key, agent_id, status, next_seq, chain_head, chain_len, opened_at, closed_at)
        VALUES (${phList(d, 9)})
        ON CONFLICT (saga_id) DO UPDATE SET
          key = excluded.key, agent_id = excluded.agent_id, status = excluded.status,
          next_seq = excluded.next_seq, chain_head = excluded.chain_head, chain_len = excluded.chain_len,
          opened_at = excluded.opened_at, closed_at = excluded.closed_at`;
      await adapter.run(sql, [
        saga.saga_id,
        saga.key ?? null,
        saga.agent_id ?? null,
        saga.status,
        saga.next_seq,
        saga.chain_head,
        saga.chain_len,
        saga.opened_at,
        saga.closed_at ?? null,
      ]);
    },
    async getEffect(effectId) {
      const row = await adapter.get(`SELECT * FROM effects WHERE effect_id = ${ph(d, 1)}`, [effectId]);
      return row ? rowToEffect(row) : undefined;
    },
    async upsertEffect(effect) {
      const cols = EFFECT_COLUMNS.join(", ");
      const updates = EFFECT_COLUMNS.filter((c) => c !== "effect_id")
        .map((c) => `${c} = excluded.${c}`)
        .join(", ");
      const sql = `INSERT INTO effects (${cols}) VALUES (${phList(d, EFFECT_COLUMNS.length)})
        ON CONFLICT (effect_id) DO UPDATE SET ${updates}`;
      await adapter.run(sql, effectBindValues(effect));
    },
    async listEffects(sagaId) {
      const rows = await adapter.all(
        `SELECT * FROM effects WHERE saga_id = ${ph(d, 1)} ORDER BY seq ASC`,
        [sagaId],
      );
      return rows.map((r) => rowToEffect(r));
    },
    async appendAttempt(row) {
      const sql = `INSERT INTO attempts (attempt_id, idempotency_key, effect_id, plan_id, step_index, fence, state, started_at, finished_at, error_code, response_hash)
        VALUES (${phList(d, 11)})`;
      try {
        await adapter.run(sql, [
          row.attempt_id,
          row.idempotency_key,
          row.effect_id,
          row.plan_id,
          row.step_index,
          row.fence,
          row.state,
          row.started_at,
          row.finished_at ?? null,
          row.error_code ?? null,
          row.response_hash ?? null,
        ]);
      } catch (err) {
        if (isDuplicateAttempt(err) || /UNIQUE/i.test(err instanceof Error ? err.message : String(err))) {
          throw new DuplicateAttemptError(row.idempotency_key);
        }
        wrapSqliteError(err);
      }
      await adapter.durableFlush();
      lastFsyncMs = clock().getTime();
    },
    async getAttempt(attemptId) {
      const row = await adapter.get(`SELECT * FROM attempts WHERE attempt_id = ${ph(d, 1)}`, [attemptId]);
      return row ? rowToAttempt(row) : undefined;
    },
    async getAttemptByIdempotencyKey(key) {
      const row = await adapter.get(`SELECT * FROM attempts WHERE idempotency_key = ${ph(d, 1)}`, [key]);
      return row ? rowToAttempt(row) : undefined;
    },
    async updateAttempt(row) {
      await adapter.run(
        `UPDATE attempts SET fence = ${ph(d, 1)}, state = ${ph(d, 2)}, finished_at = ${ph(d, 3)}, error_code = ${ph(d, 4)}, response_hash = ${ph(d, 5)} WHERE attempt_id = ${ph(d, 6)}`,
        [row.fence, row.state, row.finished_at ?? null, row.error_code ?? null, row.response_hash ?? null, row.attempt_id],
      );
      await adapter.durableFlush();
      lastFsyncMs = clock().getTime();
    },
    async acquireLease(resourceKey, holder, leaseOpts) {
      const ttl = leaseOpts?.ttlMs ?? DEFAULT_LEASE.ttlMs;
      return adapter.tx("immediate", async () => {
        const now = clock();
        const nowIso = now.toISOString();
        await adapter.run(`DELETE FROM leases WHERE expires_at < ${ph(d, 1)}`, [nowIso]);
        if (d === "postgres") {
          await adapter.all(
            `SELECT resource_key FROM leases WHERE resource_key = ${ph(d, 1)} FOR UPDATE SKIP LOCKED`,
            [resourceKey],
          );
        }
        const existing = await adapter.get(`SELECT * FROM leases WHERE resource_key = ${ph(d, 1)}`, [resourceKey]);
        if (existing && String(existing.holder) !== holder && String(existing.expires_at) > nowIso) {
          throw new VekRevertError("VR5005");
        }
        const fence = existing ? Number(existing.fence) + 1 : 1;
        const expires_at = new Date(now.getTime() + ttl).toISOString();
        if (existing) {
          await adapter.run(
            `UPDATE leases SET holder = ${ph(d, 1)}, acquired_at = ${ph(d, 2)}, expires_at = ${ph(d, 3)}, fence = ${ph(d, 4)} WHERE resource_key = ${ph(d, 5)}`,
            [holder, nowIso, expires_at, fence, resourceKey],
          );
        } else {
          await adapter.run(
            `INSERT INTO leases (resource_key, holder, acquired_at, expires_at, fence) VALUES (${phList(d, 5)})`,
            [resourceKey, holder, nowIso, expires_at, fence],
          );
        }
        return { fence, expires_at };
      });
    },
    async releaseLease(resourceKey, holder, fence) {
      const existing = await adapter.get(`SELECT * FROM leases WHERE resource_key = ${ph(d, 1)}`, [resourceKey]);
      if (!existing) return;
      if (String(existing.holder) !== holder || Number(existing.fence) !== fence) {
        throw new VekRevertError("VR5010");
      }
      await adapter.run(
        `DELETE FROM leases WHERE resource_key = ${ph(d, 1)} AND holder = ${ph(d, 2)} AND fence = ${ph(d, 3)}`,
        [resourceKey, holder, fence],
      );
    },
    async getLease(resourceKey) {
      const row = await adapter.get(`SELECT * FROM leases WHERE resource_key = ${ph(d, 1)}`, [resourceKey]);
      return row ? rowToLease(row) : undefined;
    },
    async renewLease(resourceKey, holder, fence, leaseOpts) {
      const ttl = leaseOpts?.ttlMs ?? DEFAULT_LEASE.ttlMs;
      const now = clock();
      const expires_at = new Date(now.getTime() + ttl).toISOString();
      const existing = await adapter.get(`SELECT * FROM leases WHERE resource_key = ${ph(d, 1)}`, [resourceKey]);
      if (!existing || String(existing.holder) !== holder || Number(existing.fence) !== fence) {
        throw new VekRevertError("VR5010");
      }
      await adapter.run(
        `UPDATE leases SET expires_at = ${ph(d, 1)} WHERE resource_key = ${ph(d, 2)} AND holder = ${ph(d, 3)} AND fence = ${ph(d, 4)}`,
        [expires_at, resourceKey, holder, fence],
      );
      return { expires_at };
    },
    async putPlan(plan) {
      const sql = `INSERT INTO plans (plan_id, effect_id, saga_id, compensator_id, origin, steps, plan_hash, postconditions, reversal_completeness, leak, cascade_risk, summary, verification, created_at)
        VALUES (${phList(d, 14)})
        ON CONFLICT (plan_id) DO UPDATE SET
          effect_id = excluded.effect_id, saga_id = excluded.saga_id, compensator_id = excluded.compensator_id,
          origin = excluded.origin, steps = excluded.steps, plan_hash = excluded.plan_hash,
          postconditions = excluded.postconditions, reversal_completeness = excluded.reversal_completeness,
          leak = excluded.leak, cascade_risk = excluded.cascade_risk, summary = excluded.summary,
          verification = excluded.verification, created_at = excluded.created_at`;
      await adapter.run(sql, [
        plan.plan_id,
        plan.effect_id,
        plan.saga_id,
        plan.compensator_id,
        plan.origin,
        jsonText(plan.steps as unknown as JsonValue),
        plan.plan_hash,
        jsonText(plan.postconditions as unknown as JsonValue),
        plan.reversal_completeness,
        plan.leak,
        plan.cascade_risk,
        plan.summary,
        plan.verification != null ? jsonText(plan.verification as unknown as JsonValue) : null,
        plan.created_at,
      ]);
    },
    async getPlan(planId) {
      const row = await adapter.get(`SELECT * FROM plans WHERE plan_id = ${ph(d, 1)}`, [planId]);
      return row ? rowToPlan(row) : undefined;
    },
    async putBlob(bytes) {
      const blob_id = blobIdFor(bytes);
      const existing = await adapter.get(`SELECT blob_id, refcount FROM blobs WHERE blob_id = ${ph(d, 1)}`, [blob_id]);
      if (existing) {
        await adapter.run(`UPDATE blobs SET refcount = refcount + 1 WHERE blob_id = ${ph(d, 1)}`, [blob_id]);
        return blob_id;
      }
      const inline = bytes.byteLength <= BLOB_INLINE_MAX;
      await adapter.run(
        `INSERT INTO blobs (blob_id, bytes, created_at, refcount, storage, inline, path) VALUES (${phList(d, 7)})`,
        [
          blob_id,
          bytes.byteLength,
          isoNow(clock),
          1,
          inline ? "inline" : "file",
          inline ? Buffer.from(bytes) : null,
          inline ? null : blob_id,
        ],
      );
      return blob_id;
    },
    async getBlob(blobId) {
      const row = await adapter.get(`SELECT inline, storage, path FROM blobs WHERE blob_id = ${ph(d, 1)}`, [blobId]);
      if (!row) return null;
      if (row.inline) {
        const raw = row.inline as Buffer | Uint8Array;
        return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      }
      return null;
    },
    async appendAnchor(row) {
      const existing = await adapter.get(`SELECT anchor_seq FROM anchors WHERE anchor_seq = ${ph(d, 1)}`, [row.anchor_seq]);
      if (existing) return;
      await adapter.run(
        `INSERT INTO anchors (anchor_seq, merkle_root, saga_heads, prev_anchor_hash, hash, sig, anchored_at)
         VALUES (${phList(d, 7)})`,
        [
          row.anchor_seq,
          row.merkle_root,
          jsonText(row.saga_heads as unknown as JsonValue),
          row.prev_anchor_hash,
          row.hash,
          row.sig ?? null,
          row.anchored_at,
        ],
      );
    },
    async listAnchors() {
      const rows = await adapter.all(`SELECT * FROM anchors ORDER BY anchor_seq ASC`);
      return rows.map((r) => ({
        anchor_seq: Number(r.anchor_seq),
        merkle_root: String(r.merkle_root),
        saga_heads: parseJson(r.saga_heads as string, []) as AnchorRecord["saga_heads"],
        prev_anchor_hash: String(r.prev_anchor_hash),
        hash: String(r.hash),
        sig: r.sig != null ? String(r.sig) : undefined,
        anchored_at: String(r.anchored_at),
      }));
    },
    async rebuildProjections(sagaId, rebuildOpts) {
      const events = (await api.readSaga(sagaId)).filter((e) => !rebuildOpts?.asOf || e.ts <= rebuildOpts.asOf);
      const folded = foldEvents(events);
      const storedSagas = new Map<string, Saga>();
      const storedEffects = new Map<string, EffectProjection>();
      const s = await api.getSaga(sagaId);
      if (s) storedSagas.set(sagaId, s);
      for (const e of await api.listEffects(sagaId)) storedEffects.set(e.effect_id, e);
      const divergences = diffProjections(folded.sagas, folded.effects, storedSagas, storedEffects, sagaId);
      await adapter.run(`DELETE FROM effects WHERE saga_id = ${ph(d, 1)}`, [sagaId]);
      const rebuiltSaga = folded.sagas.get(sagaId);
      if (rebuiltSaga) await api.upsertSaga(rebuiltSaga);
      for (const e of folded.effects.values()) await api.upsertEffect(e);
      return divergences;
    },
    async tickAnchor() {
      await fireAnchor();
    },
    async maybeTickAnchor() {
      if (anchoring) return false;
      await bootstrapCounts();
      const now = clock().getTime();
      const dueCount = eventCount - lastAnchorCount >= anchorEvery;
      const dueTime = now - lastAnchorMs >= anchorIntervalMs;
      if (!dueCount && !dueTime) return false;
      const user = await adapter.get(
        `SELECT COUNT(*) AS n FROM sagas WHERE saga_id <> ${ph(d, 1)}`,
        [ANCHOR_SAGA_ID],
      );
      if (Number(user?.n ?? 0) === 0) return false;
      await fireAnchor();
      return true;
    },
    async listCompensators() {
      const rows = await adapter.all(`SELECT * FROM compensators`);
      return rows.map(rowToCompensator);
    },
    async upsertCompensator(row) {
      const sql = `INSERT INTO compensators (id, manifest, source, match_kind, specificity, signature, registered_at, disabled)
        VALUES (${phList(d, 8)})
        ON CONFLICT (id) DO UPDATE SET
          manifest = excluded.manifest, source = excluded.source, match_kind = excluded.match_kind,
          specificity = excluded.specificity, signature = excluded.signature,
          registered_at = excluded.registered_at, disabled = excluded.disabled`;
      await adapter.run(sql, [
        row.id,
        jsonText(row.manifest),
        row.source,
        row.match_kind,
        row.specificity,
        row.signature ?? null,
        row.registered_at,
        row.disabled,
      ]);
    },
    async getCompensator(id) {
      const row = await adapter.get(`SELECT * FROM compensators WHERE id = ${ph(d, 1)}`, [id]);
      return row ? rowToCompensator(row) : undefined;
    },
    async close() {
      closed = true;
      await adapter.close();
    },
  };

  async function fireAnchor(): Promise<void> {
    if (anchoring) return;
    anchoring = true;
    try {
      const sagaRows = await adapter.all(`SELECT saga_id, chain_head, chain_len FROM sagas WHERE saga_id <> ${ph(d, 1)}`, [
        ANCHOR_SAGA_ID,
      ]);
      const heads = sagaRows
        .map((r) => ({
          saga_id: String(r.saga_id),
          chain_head: String(r.chain_head),
          chain_len: Number(r.chain_len),
        }))
        .sort((a, b) => (a.saga_id < b.saga_id ? -1 : a.saga_id > b.saga_id ? 1 : 0));
      const merkle_root = merkleRoot(heads.map((h) => ({ saga_id: h.saga_id, chain_head: h.chain_head })));
      const prevRow = await adapter.get(`SELECT hash, anchor_seq FROM anchors ORDER BY anchor_seq DESC LIMIT 1`);
      const prev_anchor_hash = prevRow ? String(prevRow.hash) : genesisHash(ANCHOR_SAGA_ID);
      const anchor_seq = prevRow ? Number(prevRow.anchor_seq) + 1 : 1;
      const anchored_at = isoNow(clock);
      const prior = await api.readSaga(ANCHOR_SAGA_ID);
      const prev_hash = prior.length ? prior[prior.length - 1]!.hash : genesisHash(ANCHOR_SAGA_ID);
      const chain_seq = prior.length + 1;
      const body = {
        v: "vekrevert/v1" as const,
        id: newEventId(clock().getTime()),
        type: "ledger_anchored" as const,
        ts: anchored_at,
        saga_id: ANCHOR_SAGA_ID,
        chain_seq,
        actor: { kind: "system" as const, id: "vekrevert" },
        payload: { anchor_seq, merkle_root, saga_heads: heads, prev_anchor_hash, anchored_at },
        prev_hash,
      };
      const chained = chainEvent(body, prev_hash);
      await api.append(chained as ReceiptEvent);
      lastAnchorCount = eventCount;
      lastAnchorMs = clock().getTime();
    } finally {
      anchoring = false;
    }
  }

  return api;
}
