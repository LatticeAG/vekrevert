/** EP1 openEffect / EP2 closeEffect. Two-phase WAL, sealed receipts (D2). */
import {
  classifyAction,
  classifyStructural,
  classifySql,
  chainEvent,
  deriveEffectId,
  deriveIntentKey,
  genesisHash,
  hashJcs,
  resourceKeys,
  sealHash,
  stripVolatile,
  SDK_VERSION,
  VekRevertError,
  DEFAULT_LIMITS,
  type ActionRef,
  type ActionSignature,
  type Actor,
  type BindingExtractor,
  type CaptureFidelity,
  type ClassificationRecord,
  type CompensationState,
  type EffectReceipt,
  type EffectStatus,
  type JsonValue,
  type PreimageRef,
  type Tier,
  type VekRevertConfig,
  TIER_ORDER,
} from "@latticeag/vekrevert-core";
import { classifyModel, escalateOnly } from "./classify/model.ts";
import type { ReceiptEvent, VekRevertEventType } from "@latticeag/vekrevert-events";
import type { Ledger } from "./ledger/types.ts";
import { newEventId } from "./ulid.ts";
import { redactArgs } from "./redact.ts";
import { putPreimage, type PreimagePutInput } from "./preimage/store.ts";
import type { CompensatorRegistry } from "./registry.ts";
import { getCompensationContext } from "./engine/context.ts";
import { beginInflight, endInflight, findInflight, fidelityRank } from "./capture/inflight.ts";

const SCALAR_BIND_MAX = 512;

export interface EffectHost {
  config: VekRevertConfig;
  ledgerHandle?: Ledger;
  captureFailures: number;
  version: string;
  actor?: Actor;
  clock?: () => Date;
  registry?: CompensatorRegistry;
  currentSagaId?: string;
  fetch?: typeof fetch;
}

export interface CapturePreimageInput extends PreimagePutInput {}

export interface EffectSpec<R = unknown> {
  action: ActionRef;
  args: JsonValue;
  run: () => Promise<R>;
  signature?: Partial<ActionSignature>;
  capturePreimage?: () => Promise<CapturePreimageInput> | CapturePreimageInput;
  capture?: { fidelity?: CaptureFidelity; interceptor?: string };
}

export interface OpenedEffect {
  effect_id: string;
  saga_id: string;
  seq: number;
  action: ActionRef;
  args: JsonValue;
  args_hash: string;
  args_observed: JsonValue;
  args_commitments?: Record<string, string>;
  intent_key: string;
  classification: ClassificationRecord;
  tier: Tier;
  preimage?: PreimageRef;
  opened_at: string;
  redactions: string[];
  recorded: boolean;
  signature?: Partial<ActionSignature>;
  restore_sibling_of?: string;
  restore_boundary_seq?: number;
  parent_effect_id?: string;
  warnings: string[];
  capture_fidelity: CaptureFidelity;
  capture_interceptor: string;
}

export interface CloseEffectOpts {
  result?: unknown;
  error?: unknown;
  status?: EffectStatus;
}

export interface ClosedEffect<R = unknown> {
  value?: R;
  receipt?: EffectReceipt;
  degraded: boolean;
  status: EffectStatus;
  recorded: boolean;
}

function nowIso(host: EffectHost): string {
  return (host.clock ?? (() => new Date()))().toISOString();
}

function actorOf(host: EffectHost): Actor {
  return host.actor ?? { kind: "agent", id: host.config.agentId ?? "vekrevert" };
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function headerMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  if (typeof (raw as { forEach?: unknown }).forEach === "function" && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    (raw as { forEach: (cb: (v: string, k: string) => void) => void }).forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

export interface ObservedCall {
  status?: number;
  headers: Record<string, string>;
  body: JsonValue;
  timeout: boolean;
  transportError: boolean;
  raw: JsonValue;
}

export function observeResult(result: unknown, error?: unknown): ObservedCall {
  const fromErr = error != null ? asRecord(error) : {};
  const rec = asRecord(result);
  const timeout =
    Boolean(fromErr.timeout) ||
    Boolean(rec.timeout) ||
    fromErr.code === "ETIMEDOUT" ||
    fromErr.code === "TIMEOUT" ||
    (error instanceof Error && /timeout/i.test(error.message));
  const transportError =
    Boolean(fromErr.transportError) ||
    Boolean(rec.transportError) ||
    fromErr.code === "ECONNRESET" ||
    fromErr.code === "ECONNREFUSED" ||
    (error instanceof Error && /transport/i.test(error.message));
  const statusRaw = rec.status ?? rec.statusCode ?? fromErr.status ?? fromErr.statusCode;
  const status = typeof statusRaw === "number" ? statusRaw : undefined;
  const headers = headerMap(rec.headers ?? fromErr.headers);
  let body: JsonValue;
  if (rec.body !== undefined) body = toJson(rec.body);
  else if (result !== undefined && (status != null || rec.headers != null)) {
    const { status: _s, statusCode: _sc, headers: _h, timeout: _t, transportError: _te, ...rest } = rec;
    body = toJson(rest);
  } else if (result !== undefined) body = toJson(result);
  else body = null;
  return { status, headers, body, timeout, transportError, raw: toJson(result ?? null) };
}

function rejectPath(path: string): boolean {
  return path.includes("..") || path.includes("?(") || path.includes("@.");
}

function tokenizeJsonPath(path: string): Array<string | number> {
  const p = path.replace(/^\$\.?/, "");
  if (!p) return [];
  const tokens: Array<string | number> = [];
  let i = 0;
  while (i < p.length) {
    if (p[i] === ".") {
      i++;
      continue;
    }
    if (p[i] === "[") {
      const end = p.indexOf("]", i);
      if (end < 0) break;
      const inner = p.slice(i + 1, end).trim();
      if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
        tokens.push(inner.slice(1, -1));
      } else {
        tokens.push(Number(inner));
      }
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < p.length && p[j] !== "." && p[j] !== "[") j++;
    tokens.push(p.slice(i, j));
    i = j;
  }
  return tokens;
}

function getAtPath(root: JsonValue, path: string): JsonValue | undefined {
  if (rejectPath(path)) return undefined;
  const tokens = tokenizeJsonPath(path);
  let cur: unknown = root;
  for (const t of tokens) {
    if (cur == null || typeof cur !== "object") return undefined;
    if (typeof t === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t];
    } else {
      cur = (cur as Record<string, unknown>)[t];
    }
  }
  return cur as JsonValue | undefined;
}

function parseFrom(from: string): { source: "args" | "result" | "header" | "status"; path: string } {
  if (from === "status") return { source: "status", path: "" };
  if (from.startsWith("header.")) return { source: "header", path: from.slice("header.".length).replace(/^\$\.?/, "") };
  if (from.startsWith("args.")) return { source: "args", path: from.slice("args.".length) };
  if (from.startsWith("result.")) return { source: "result", path: from.slice("result.".length) };
  return { source: "result", path: from };
}

function extractOne(
  extractor: BindingExtractor,
  args: JsonValue,
  observed: ObservedCall,
): JsonValue | undefined {
  const { source, path } = parseFrom(extractor.from);
  let value: JsonValue | undefined;
  if (source === "status") value = observed.status ?? null;
  else if (source === "header") {
    const want = path.toLowerCase();
    for (const [k, v] of Object.entries(observed.headers)) {
      if (k.toLowerCase() === want) {
        value = v;
        break;
      }
    }
  } else if (source === "args") value = getAtPath(args, path);
  else value = getAtPath(observed.body, path) ?? getAtPath(observed.raw, path);
  if (value === undefined) return undefined;
  if (extractor.pattern && (typeof value !== "string" || !new RegExp(extractor.pattern).test(value))) {
    return undefined;
  }
  return value;
}

function defaultBindings(
  observed: ObservedCall,
): { bindings: Record<string, JsonValue>; binding_paths: Record<string, string> } {
  const bindings: Record<string, JsonValue> = {};
  const binding_paths: Record<string, string> = {};
  for (const [k, v] of Object.entries(observed.headers)) {
    if (k.toLowerCase() === "location") {
      bindings.Location = v;
      binding_paths.Location = "header.Location";
    }
  }
  const body = observed.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const name of ["id", "name", "key", "uuid"] as const) {
      if (body[name] !== undefined) {
        bindings[name] = body[name] as JsonValue;
        binding_paths[name] = `result.$.${name}`;
      }
    }
    for (const [k, v] of Object.entries(body)) {
      if (k in bindings) continue;
      if (v === null || typeof v === "object") continue;
      const bytes = typeof v === "string" ? Buffer.byteLength(v) : Buffer.byteLength(String(v));
      if (bytes > SCALAR_BIND_MAX) continue;
      bindings[k] = v as JsonValue;
      binding_paths[k] = `result.$.${k}`;
    }
  }
  return { bindings, binding_paths };
}

function addDuration(fromIso: string, window: string): string | undefined {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(window);
  if (!m) return undefined;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3] ?? 0);
  const secs = Number(m[4] ?? 0);
  const ms = Date.parse(fromIso) + (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
  return new Date(ms).toISOString();
}

export async function appendChained(
  ledger: Ledger,
  sagaId: string,
  type: VekRevertEventType,
  payload: JsonValue,
  host: EffectHost,
  effectId?: string,
  appendOpts?: { fsync?: boolean },
): Promise<ReceiptEvent> {
  const saga = await ledger.getSaga(sagaId);
  const prev = saga?.chain_head ?? genesisHash(sagaId);
  const chain_seq = (saga?.chain_len ?? 0) + 1;
  const body = {
    v: "vekrevert/v1" as const,
    id: newEventId(),
    type,
    ts: nowIso(host),
    saga_id: sagaId,
    chain_seq,
    ...(effectId ? { effect_id: effectId } : {}),
    actor: actorOf(host),
    payload,
    prev_hash: prev,
  };
  const chained = chainEvent(body, prev);
  await ledger.append(chained as ReceiptEvent, appendOpts);
  return chained as ReceiptEvent;
}

async function findRestoreSibling(
  ledger: Ledger,
  sagaId: string,
  intentKey: string,
): Promise<{ siblingId: string; boundarySeq: number } | undefined> {
  const events = await ledger.readSaga(sagaId);
  const effects = await ledger.listEffects(sagaId);
  const byId = new Map(effects.map((e) => [e.effect_id, e]));
  let lastBoundaryChain = -1;
  const openedAt = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "restore_boundary") lastBoundaryChain = ev.chain_seq;
    if (ev.type === "effect_opened" && ev.effect_id) openedAt.set(ev.effect_id, ev.chain_seq);
  }
  if (lastBoundaryChain < 0) return undefined;
  const candidates = effects
    .filter((e) => e.intent_key === intentKey)
    .sort((a, b) => a.seq - b.seq);
  for (const prior of candidates) {
    const openSeq = openedAt.get(prior.effect_id) ?? 0;
    if (openSeq < lastBoundaryChain) {
      void byId;
      return { siblingId: prior.effect_id, boundarySeq: lastBoundaryChain };
    }
  }
  return undefined;
}

function needsPreimageCapture(action: ActionRef, tier: Tier, signature?: Partial<ActionSignature>): boolean {
  if (action.kind === "fs" || action.kind === "sql") return true;
  if (tier === "T2") return true;
  if (signature?.preimage?.required) return true;
  return false;
}

function classifyCtx(host: EffectHost, extra: Record<string, unknown> = {}) {
  return {
    writableRoots: host.config.writableRoots,
    internalHosts: host.config.internalHosts,
    maxPreimageBytes: host.config.limits?.maxPreimageBytes ?? DEFAULT_LIMITS.maxPreimageBytes,
    maxPreimageRows: host.config.limits?.maxPreimageRows ?? DEFAULT_LIMITS.maxPreimageRows,
    ...extra,
  };
}

/** EP1 local T4 policy. LexShield adapter is Phase 9. */
export function preflightPolicy(host: EffectHost, classification: ClassificationRecord): void {
  if (host.config.policy?.blockT4 === true && classification.tier === "T4") {
    throw new VekRevertError("VR1010", "t4_blocked");
  }
}

export async function openEffect(host: EffectHost, sagaId: string, spec: EffectSpec): Promise<OpenedEffect> {
  const ledger = host.ledgerHandle;
  if (!ledger) throw new VekRevertError("VR2002", "ledger not open");
  const { action, args, signature } = spec;

  const compensationCtx = getCompensationContext();
  if (compensationCtx) {
    try {
      await appendChained(
        ledger,
        sagaId,
        "compensation_side_effect",
        { compensation_of: compensationCtx.attempt_id, action } as unknown as JsonValue,
        host,
        undefined,
        { fsync: false },
      );
    } catch {
      /* observability only; never block the compensation */
    }
    return {
      effect_id: "",
      saga_id: sagaId,
      seq: 0,
      action,
      args,
      args_hash: "",
      args_observed: args,
      intent_key: "",
      classification: {
        tier: "T1",
        sources: [],
        reasons: ["compensation_bypass"],
        candidates: [],
        scope_violation: false,
      },
      tier: "T1",
      opened_at: nowIso(host),
      redactions: [],
      recorded: false,
      signature,
      warnings: ["compensation_side_effect"],
      capture_fidelity: spec.capture?.fidelity ?? "full",
      capture_interceptor: spec.capture?.interceptor ?? "sdk-ts",
    };
  }
  const redacted = redactArgs(args, {
    paths: host.config.redact?.paths,
    patterns: host.config.redact?.patterns,
  });

  const captureFidelity = spec.capture?.fidelity ?? "full";
  const captureInterceptor = spec.capture?.interceptor ?? "sdk-ts";
  let classification = classifyAction(
    action,
    args,
    classifyCtx(host, { manifest: signature as ActionSignature | undefined, captureFidelity }),
  );
  const recordT1 = host.config.recordT1 === true;

  if (classification.tier === "T1" && !recordT1) {
    await appendChained(
      ledger,
      sagaId,
      "reversibility_classified",
      {
        action,
        tier: classification.tier,
        sources: classification.sources,
        reasons: classification.reasons,
        candidates: classification.candidates,
        scope_violation: classification.scope_violation,
      } as unknown as JsonValue,
      host,
    );
    return {
      effect_id: "",
      saga_id: sagaId,
      seq: 0,
      action,
      args,
      args_hash: redacted.args_hash,
      args_observed: redacted.args_observed,
      intent_key: deriveIntentKey(action.name, stripVolatile(args, signature?.volatile)),
      classification,
      tier: "T1",
      opened_at: nowIso(host),
      redactions: redacted.redactions,
      recorded: false,
      signature,
      warnings: [],
      capture_fidelity: captureFidelity,
      capture_interceptor: captureInterceptor,
    };
  }

  const warnings: string[] = [];
  let preimage: PreimageRef | undefined;
  if (spec.capturePreimage && needsPreimageCapture(action, classification.tier, signature)) {
    try {
      const captured = await spec.capturePreimage();
      preimage = await putPreimage(ledger, {
        ...captured,
        maxBytes: host.config.limits?.maxPreimageBytes ?? captured.maxBytes ?? DEFAULT_LIMITS.maxPreimageBytes,
        maxRows: host.config.limits?.maxPreimageRows ?? captured.maxRows ?? DEFAULT_LIMITS.maxPreimageRows,
      });
    } catch (err) {
      warnings.push(`preimage_unreadable:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (preimage?.truncated) {
    classification = classifyAction(action, args, classifyCtx(host, { preimage, manifest: signature as ActionSignature | undefined, captureFidelity }));
  } else if (preimage) {
    classification = classifyAction(action, args, classifyCtx(host, { preimage, manifest: signature as ActionSignature | undefined, captureFidelity }));
  }

  const saga = await ledger.getSaga(sagaId);
  const seq = saga?.next_seq ?? 1;
  const intent_key = deriveIntentKey(action.name, stripVolatile(args, signature?.volatile));
  const linked = findInflight(intent_key);
  if (linked && fidelityRank(captureFidelity) <= fidelityRank(linked.fidelity)) {
    return {
      effect_id: linked.effect_id,
      saga_id: sagaId,
      seq: 0,
      action,
      args,
      args_hash: redacted.args_hash,
      args_observed: redacted.args_observed,
      intent_key,
      classification,
      tier: classification.tier,
      opened_at: nowIso(host),
      redactions: redacted.redactions,
      recorded: false,
      signature,
      parent_effect_id: linked.effect_id,
      warnings: ["linked_duplicate"],
      capture_fidelity: captureFidelity,
      capture_interceptor: captureInterceptor,
    };
  }
  const effect_id = deriveEffectId({
    saga_id: sagaId,
    seq,
    action_name: action.name,
    args_hash: redacted.args_hash,
  });

  const sibling = await findRestoreSibling(ledger, sagaId, intent_key);

  const opened_at = nowIso(host);
  try {
    await appendChained(
      ledger,
      sagaId,
      "reversibility_classified",
      {
        action,
        tier: classification.tier,
        sources: classification.sources,
        reasons: classification.reasons,
        candidates: classification.candidates,
        scope_violation: classification.scope_violation,
      } as unknown as JsonValue,
      host,
    );
    await appendChained(
      ledger,
      sagaId,
      "effect_opened",
      {
        effect_id,
        seq,
        action,
        tier: classification.tier,
        args_hash: redacted.args_hash,
        intent_key,
        ...(preimage ? { preimage } : {}),
        args_observed: redacted.args_observed,
        ...(redacted.args_commitments && Object.keys(redacted.args_commitments).length
          ? { args_commitments: redacted.args_commitments }
          : {}),
        classification,
        opened_at,
        ...(sibling ? { restore_sibling_of: sibling.siblingId } : {}),
        redactions: redacted.redactions,
      } as unknown as JsonValue,
      host,
      effect_id,
    );
  } catch (err) {
    const existing = await ledger.getEffect(effect_id);
    if (existing) {
      try {
        await appendChained(
          ledger,
          sagaId,
          "effect_in_doubt",
          { reason: "opened_never_closed", probe_scheduled: false } as unknown as JsonValue,
          host,
          effect_id,
        );
      } catch {
        /* still fail closed */
      }
    }
    if (err instanceof VekRevertError && err.code === "VR2002") throw err;
    throw new VekRevertError("VR2002", err instanceof Error ? err.message : String(err));
  }

  const row = await ledger.getEffect(effect_id);
  if (row) {
    row.args_observed = redacted.args_observed;
    row.classification = classification as unknown as JsonValue;
    row.intent_key = intent_key;
    row.args_hash = redacted.args_hash;
    row.redactions = redacted.redactions;
    if (redacted.args_commitments && Object.keys(redacted.args_commitments).length) {
      row.args_commitments = redacted.args_commitments;
    }
    if (sibling) row.restore_sibling_of = sibling.siblingId;
    if (preimage) {
      row.preimage_kind = preimage.kind;
      row.preimage_blob_id = preimage.blob_id;
      row.preimage_bytes = preimage.bytes;
      row.preimage_rows = preimage.rows;
      row.preimage_truncated = preimage.truncated ? 1 : 0;
      row.preimage_meta = preimage.meta as JsonValue | undefined;
    }
    row.tier = classification.tier;
    row.capture_interceptor = captureInterceptor;
    row.capture_fidelity = captureFidelity;
    await ledger.upsertEffect(row);
  }

  if (host.config.policy?.blockT4 === true && host.config.models?.classifier) {
    const s4 = await classifyModel(action, args, {
      enabled: true,
      model: host.config.models.classifier.model,
      timeoutMs: host.config.models.classifier.timeoutMs,
    });
    if (s4) {
      classification = classifyAction(
        action,
        args,
        classifyCtx(host, {
          manifest: signature as ActionSignature | undefined,
          captureFidelity,
          modelTier: s4.tier,
        }),
      );
    }
  }

  preflightPolicy(host, classification);
  beginInflight({ effect_id, fidelity: captureFidelity, intent_key });

  return {
    effect_id,
    saga_id: sagaId,
    seq,
    action,
    args,
    args_hash: redacted.args_hash,
    args_observed: redacted.args_observed,
    args_commitments: Object.keys(redacted.args_commitments).length ? redacted.args_commitments : undefined,
    intent_key,
    classification,
    tier: classification.tier,
    preimage,
    opened_at,
    redactions: redacted.redactions,
    recorded: true,
    signature,
    restore_sibling_of: sibling?.siblingId,
    restore_boundary_seq: sibling?.boundarySeq,
    warnings,
    capture_fidelity: captureFidelity,
    capture_interceptor: captureInterceptor,
  };
}

function isMutating(action: ActionRef, args: JsonValue): boolean {
  const s = classifyStructural(action, args);
  return s.tier !== "T1";
}

function compensationFor(
  tier: Tier,
  matched: boolean,
  truncated: boolean,
  bindingMissing: boolean,
): CompensationState {
  if (tier === "T1") return "none_required";
  if (truncated || bindingMissing || tier === "T4" || (tier === "T3" && !matched)) return "unavailable";
  return "available";
}

export async function closeEffect<R>(
  host: EffectHost,
  opened: OpenedEffect,
  opts: CloseEffectOpts & { value?: R } = {},
): Promise<ClosedEffect<R>> {
  if (opened.intent_key) endInflight(opened.intent_key);
  if (!opened.recorded) {
    return { value: opts.value, degraded: false, status: "landed", recorded: false };
  }
  const ledger = host.ledgerHandle;
  if (!ledger) {
    host.captureFailures += 1;
    return { value: opts.value, degraded: true, status: "in_doubt", recorded: true };
  }

  const observed = observeResult(opts.result ?? opts.value, opts.error);
  let signature: ActionSignature | undefined = opened.signature as ActionSignature | undefined;
  if (!signature?.id && host.registry) {
    const found = host.registry.match(opened.action, opened.args, observed.raw);
    if (found.matched) signature = found.matched;
  }
  const structural = classifyStructural(
    opened.action,
    opened.args,
    classifyCtx(host, {
      result: observed.body,
      resultStatus: observed.status,
      resultHeaders: observed.headers,
      preimage: opened.preimage,
      transportError: observed.transportError,
      timeout: observed.timeout,
      manifest: signature,
      captureFidelity: opened.capture_fidelity,
    }),
  );
  let classification = classifyAction(
    opened.action,
    opened.args,
    classifyCtx(host, {
      result: observed.body,
      resultStatus: observed.status,
      resultHeaders: observed.headers,
      preimage: opened.preimage,
      transportError: observed.transportError,
      timeout: observed.timeout,
      compensatorMatched: Boolean(signature?.id),
      manifest: signature,
      captureFidelity: opened.capture_fidelity,
    }),
  );

  let status: EffectStatus = opts.status ?? "landed";
  if (opts.error && status === "landed") status = "failed";
  const mutating = isMutating(opened.action, opened.args);
  if (
    mutating &&
    (observed.timeout || observed.transportError || (observed.status != null && observed.status >= 500) || structural.in_doubt)
  ) {
    status = "in_doubt";
  }
  if (opts.error && !observed.timeout && !observed.transportError && (observed.status == null || observed.status < 500)) {
    if (status !== "in_doubt") status = "failed";
  }

  const result_hash = hashJcs(observed.raw);
  const binds = signature?.binds;
  let bindings: Record<string, JsonValue> = {};
  let binding_paths: Record<string, string> = {};
  let bindingMissing = false;
  if (binds && Object.keys(binds).length > 0) {
    for (const [name, extractor] of Object.entries(binds)) {
      const value = extractOne(extractor, opened.args, observed);
      if (value === undefined) {
        if (extractor.required) bindingMissing = true;
        continue;
      }
      bindings[name] = value;
      binding_paths[name] = extractor.from;
    }
  } else {
    const d = defaultBindings(observed);
    bindings = d.bindings;
    binding_paths = d.binding_paths;
  }

  if (typeof bindings.resource_url === "string") {
    const loc = bindings.resource_url;
    const base = typeof asRecord(opened.args).url === "string" ? String(asRecord(opened.args).url) : undefined;
    try {
      bindings.resource_url = new URL(loc, base).toString();
    } catch {
      /* keep raw */
    }
  } else if (bindings.id != null) {
    const base = typeof asRecord(opened.args).url === "string" ? String(asRecord(opened.args).url) : undefined;
    if (base) {
      const u = base.endsWith("/") ? `${base}${bindings.id}` : `${base}/${bindings.id}`;
      bindings.resource_url = u;
      binding_paths.resource_url = binding_paths.id ?? "result.$.id";
    }
  }

  const sqlArgs = asRecord(opened.args);
  const sqlKind =
    opened.action.kind === "sql"
      ? (typeof sqlArgs.statement === "string" ? sqlArgs.statement.toUpperCase() : classifySql(typeof sqlArgs.sql === "string" ? sqlArgs.sql : "").kind)
      : "";
  if (sqlKind === "INSERT" && bindings.pk == null && bindings.id == null) {
    classification = {
      ...classification,
      tier: "T4",
      reasons: [...classification.reasons, "insert_no_pk"],
    };
    signature = undefined;
  }

  const truncated = Boolean(opened.preimage?.truncated);
  const matched = Boolean(signature?.id);
  if (truncated) classification = { ...classification, tier: "T4", reasons: [...classification.reasons, "preimage_truncated"] };

  const compensation_state = compensationFor(classification.tier, matched, truncated, bindingMissing);
  const argRec = asRecord(opened.args);
  const keys = resourceKeys({
    action: opened.action,
    bindings,
    args: opened.args,
    result: observed.body,
    headers: observed.headers,
    dialect: typeof argRec.dialect === "string" ? argRec.dialect : undefined,
    table: typeof argRec.table === "string" ? argRec.table : undefined,
    realpath: typeof argRec.realpath === "string" ? argRec.realpath : typeof argRec.path === "string" ? argRec.path : undefined,
  });

  const closed_at = nowIso(host);
  const duration_ms = Math.max(0, Date.parse(closed_at) - Date.parse(opened.opened_at));
  const leak = signature?.leak ?? "none";
  const cascade_risk = signature?.cascade_risk ?? "none";
  const compensable_until =
    signature?.validity_window != null ? addDuration(opened.opened_at, signature.validity_window) : undefined;

  const fidelity: CaptureFidelity = opened.warnings.length
    ? "degraded"
    : (opened.capture_fidelity ?? "full");
  const interceptor = opened.capture_interceptor ?? "sdk-ts";
  const receiptUnsealed: EffectReceipt = {
    v: "vekrevert/v1",
    effect_id: opened.effect_id,
    saga_id: opened.saga_id,
    seq: opened.seq,
    ...(opened.restore_sibling_of ? { restore_sibling_of: opened.restore_sibling_of } : {}),
    action: opened.action,
    tier: classification.tier,
    classification,
    args_observed: opened.args_observed,
    args_hash: opened.args_hash,
    ...(opened.args_commitments ? { args_commitments: opened.args_commitments } : {}),
    intent_key: opened.intent_key,
    result_observed: observed.raw,
    result_hash,
    bindings,
    binding_paths,
    resource_keys: keys,
    ...(opened.preimage ? { preimage: opened.preimage } : {}),
    status,
    compensation_state,
    ...(signature?.id ? { compensator_id: signature.id } : {}),
    capture: {
      fidelity,
      interceptor,
      sdk_version: SDK_VERSION,
      warnings: opened.warnings,
    },
    leak,
    cascade_risk,
    ...(compensable_until ? { compensable_until } : {}),
    opened_at: opened.opened_at,
    closed_at,
    duration_ms,
    redactions: opened.redactions,
    sealed: true,
  };
  const seal_hash = sealHash(receiptUnsealed as unknown as JsonValue);
  const receipt: EffectReceipt = { ...receiptUnsealed, seal_hash };

  const emitSide = async (): Promise<void> => {
    if (opened.restore_sibling_of && opened.restore_boundary_seq != null) {
      await appendChained(
        ledger,
        opened.saga_id,
        "effect_duplicate_suspected",
        {
          intent_key: opened.intent_key,
          restore_sibling_of: opened.restore_sibling_of,
          restore_boundary_seq: opened.restore_boundary_seq,
        } as unknown as JsonValue,
        host,
        opened.effect_id,
      );
    }
    if (status === "in_doubt") {
      await appendChained(
        ledger,
        opened.saga_id,
        "effect_in_doubt",
        {
          reason: observed.timeout ? "timeout" : observed.transportError ? "transportError" : "http_5xx_or_opened",
          probe_scheduled: false,
        } as unknown as JsonValue,
        host,
        opened.effect_id,
      );
    }
    if (compensation_state === "unavailable") {
      const reason_code = truncated ? "VR2005" : bindingMissing ? "VR2011" : "VR3001";
      await appendChained(
        ledger,
        opened.saga_id,
        "compensation_unavailable",
        { reason_code, candidates_considered: classification.candidates.length } as unknown as JsonValue,
        host,
        opened.effect_id,
      );
    }
    if (compensation_state === "none_required") {
      await appendChained(
        ledger,
        opened.saga_id,
        "compensation_skipped",
        { reason: "t1" } as unknown as JsonValue,
        host,
        opened.effect_id,
      );
    }
  };

  try {
    await emitSide();
    await appendChained(
      ledger,
      opened.saga_id,
      "effect_closed",
      {
        status,
        result_hash,
        bindings,
        resource_keys: keys,
        duration_ms,
        seal_hash,
        result_observed: observed.raw,
        binding_paths,
        compensation_state,
      } as unknown as JsonValue,
      host,
      opened.effect_id,
    );
    await appendChained(
      ledger,
      opened.saga_id,
      "receipt_issued",
      { effect_id: opened.effect_id, seal_hash } as unknown as JsonValue,
      host,
      opened.effect_id,
    );
  } catch (err) {
    void err;
    host.captureFailures += 1;
    try {
      await appendChained(
        ledger,
        opened.saga_id,
        "capture_degraded",
        {
          effect_id: opened.effect_id,
          warnings: ["ep2_write_failed"],
          fidelity: "degraded",
        } as unknown as JsonValue,
        host,
        opened.effect_id,
      );
    } catch {
      /* isolation: never convert a successful run into failure */
    }
    const row = await ledger.getEffect(opened.effect_id);
    if (row) {
      row.capture_fidelity = "degraded";
      row.capture_warnings = ["ep2_write_failed"];
      if (opened.restore_sibling_of) row.restore_sibling_of = opened.restore_sibling_of;
      await ledger.upsertEffect(row);
    }
    return { value: opts.value, receipt: { ...receipt, capture: { ...receipt.capture, fidelity: "degraded", warnings: ["ep2_write_failed"] } }, degraded: true, status: row?.status as EffectStatus ?? "opened", recorded: true };
  }

  const row = await ledger.getEffect(opened.effect_id);
  if (row) {
    row.result_observed = observed.raw;
    row.result_hash = result_hash;
    row.bindings = bindings;
    row.binding_paths = binding_paths;
    row.resource_keys = keys;
    row.status = status;
    row.compensation_state = compensation_state;
    row.sealed = 1;
    row.seal_hash = seal_hash;
    row.closed_at = closed_at;
    row.duration_ms = duration_ms;
    row.tier = classification.tier;
    row.classification = classification as unknown as JsonValue;
    row.capture_fidelity = fidelity;
    row.capture_interceptor = interceptor;
    row.leak = leak;
    row.cascade_risk = cascade_risk;
    row.compensable_until = compensable_until;
    if (opened.restore_sibling_of) row.restore_sibling_of = opened.restore_sibling_of;
    if (signature?.id) row.compensator_id = signature.id;
    await ledger.upsertEffect(row);
  }

  scheduleOffPathClassifier(host, ledger, opened.action, opened.args, classification.tier, opened.effect_id, opened.saga_id);

  return { value: opts.value, receipt, degraded: false, status, recorded: true };
}

function scheduleOffPathClassifier(
  host: EffectHost,
  ledger: Ledger,
  action: ActionRef,
  args: JsonValue,
  current: Tier,
  effectId: string,
  sagaId: string,
): void {
  const cfg = host.config.models?.classifier;
  if (!cfg) return;
  void classifyModel(action, args, {
    enabled: true,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
  })
    .then(async (s4) => {
      if (!s4) return;
      const raised = escalateOnly(current, s4.tier);
      if (TIER_ORDER[raised] <= TIER_ORDER[current]) return;
      const row = await ledger.getEffect(effectId);
      if (!row) return;
      if (TIER_ORDER[raised] <= TIER_ORDER[row.tier as Tier]) return;
      row.tier = raised;
      await ledger.upsertEffect(row);
      await appendChained(
        ledger,
        sagaId,
        "reversibility_classified",
        {
          action,
          tier: raised,
          sources: [{ source: "model", tier: s4.tier, reasons: s4.reasons }],
          reasons: s4.reasons,
          candidates: [],
          scope_violation: false,
        } as unknown as JsonValue,
        host,
        effectId,
      );
    })
    .catch(() => undefined);
}

export async function reconcileOpenedAsInDoubt(host: EffectHost, sagaId: string): Promise<void> {
  const ledger = host.ledgerHandle;
  if (!ledger) return;
  for (const eff of await ledger.listEffects(sagaId)) {
    if (eff.status === "opened" && !eff.sealed) {
      try {
        await appendChained(
          ledger,
          sagaId,
          "effect_in_doubt",
          { reason: "opened_never_closed", probe_scheduled: false } as unknown as JsonValue,
          host,
          eff.effect_id,
        );
      } catch {
        eff.status = "in_doubt";
        await ledger.upsertEffect(eff);
      }
      if (eff.intent_key) endInflight(eff.intent_key);
    }
  }
}

export function projectionToReceipt(row: import("./ledger/types.ts").EffectProjection): EffectReceipt {
  const action: ActionRef = {
    kind: row.action_kind as ActionRef["kind"],
    name: row.action_name,
    target: row.action_target,
    locality: row.locality as ActionRef["locality"],
  };
  const preimage: PreimageRef | undefined = row.preimage_kind
    ? {
        kind: row.preimage_kind as PreimageRef["kind"],
        blob_id: row.preimage_blob_id,
        bytes: row.preimage_bytes,
        rows: row.preimage_rows,
        truncated: row.preimage_truncated === 1,
        meta: row.preimage_meta as Record<string, string | number> | undefined,
      }
    : undefined;
  return {
    v: "vekrevert/v1",
    effect_id: row.effect_id,
    saga_id: row.saga_id,
    seq: row.seq,
    compensation_of: row.compensation_of,
    restore_sibling_of: row.restore_sibling_of,
    parent_effect_id: row.parent_effect_id,
    action,
    tier: row.tier as Tier,
    classification: row.classification as unknown as ClassificationRecord,
    args_observed: row.args_observed,
    args_hash: row.args_hash,
    args_commitments: row.args_commitments as Record<string, string> | undefined,
    intent_key: row.intent_key,
    result_observed: row.result_observed,
    result_hash: row.result_hash,
    bindings: (row.bindings as Record<string, JsonValue>) ?? {},
    binding_paths: (row.binding_paths as Record<string, string>) ?? {},
    resource_keys: Array.isArray(row.resource_keys) ? (row.resource_keys as string[]) : [],
    preimage,
    status: row.status as EffectStatus,
    compensation_state: row.compensation_state as CompensationState,
    compensator_id: row.compensator_id,
    capture: {
      fidelity: row.capture_fidelity as CaptureFidelity,
      interceptor: row.capture_interceptor,
      sdk_version: SDK_VERSION,
      warnings: Array.isArray(row.capture_warnings) ? (row.capture_warnings as string[]) : [],
    },
    leak: row.leak as EffectReceipt["leak"],
    cascade_risk: row.cascade_risk as EffectReceipt["cascade_risk"],
    compensable_until: row.compensable_until,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    duration_ms: row.duration_ms,
    redactions: Array.isArray(row.redactions) ? (row.redactions as string[]) : [],
    sealed: row.sealed === 1,
    seal_hash: row.seal_hash,
  };
}
