/** In-memory compensator registry with optional ledger persistence. */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import {
  canonicalize,
  compilePlan,
  isPlanRejection,
  isRef,
  matchCompensator,
  planHash,
  resourceKeys,
  specificityScore,
  VekRevertError,
  type ActionRef,
  type ActionSignature,
  type CompensationPlan,
  type CompensationStep,
  type EffectReceipt,
  type JsonValue,
  type MatchResult,
  type RegisterResult,
  type VRCode,
} from "@latticeag/vekrevert-core";
import { isHostedLedgerUrl } from "./ledger/http.ts";

export function hostedModeActive(ledgerUrl?: string): boolean {
  if (isHostedLedgerUrl(ledgerUrl) || isHostedLedgerUrl(process.env.VEKREVERT_LEDGER)) return true;
  return Boolean(process.env.VEKREVERT_VERIFY_KEY);
}

export function manifestBytesForSignature(m: ActionSignature): Buffer {
  const { signature: _s, registered_at: _r, disabled: _d, ...rest } = m;
  return Buffer.from(canonicalize(rest as unknown as JsonValue));
}

export function signManifest(m: ActionSignature, privateKeyPem: string): string {
  return edSign(null, manifestBytesForSignature(m), createPrivateKey(privateKeyPem)).toString("base64");
}

export function verifyKeyFromEnv(): string | undefined {
  const pub = process.env.VEKREVERT_VERIFY_KEY;
  if (pub) return pub;
  const priv = process.env.VEKREVERT_SIGNING_KEY;
  if (!priv) return undefined;
  try {
    return createPublicKey(createPrivateKey(priv))
      .export({ type: "spki", format: "pem" })
      .toString();
  } catch {
    return undefined;
  }
}

export function verifyManifestSignature(m: ActionSignature, publicKeyPem?: string): boolean {
  if (!m.signature) return false;
  const pem = publicKeyPem ?? verifyKeyFromEnv();
  if (!pem) return false;
  try {
    return edVerify(null, manifestBytesForSignature(m), createPublicKey(pem), Buffer.from(m.signature, "base64"));
  } catch {
    return false;
  }
}

/** S1: hosted matching uses only a signature-verified manifest tier. */
export function signatureVerifiedForS1(sig: ActionSignature, hosted: boolean): ActionSignature | undefined {
  if (!hosted) return sig;
  if (sig.source === "builtin") return sig;
  if (verifyManifestSignature(sig)) return sig;
  return undefined;
}

export interface CompensatorRow {
  id: string;
  manifest: ActionSignature;
  source: string;
  match_kind: string;
  specificity: number;
  signature?: string;
  registered_at: string;
  disabled: number;
}

export interface CompensatorStore {
  listCompensators(): Promise<CompensatorRow[]>;
  upsertCompensator(row: CompensatorRow): Promise<void>;
  getCompensator?(id: string): Promise<CompensatorRow | undefined>;
}

export type GateOk = { ok: true; signature: ActionSignature; plan: CompensationPlan };
export type GateErr = { ok: false; error_code: VRCode; detail: string };
export type GateResult = GateOk | GateErr;

export type RegisterOpts = {
  force?: boolean;
  now?: Date;
};

function hasStore(v: unknown): v is CompensatorStore {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as CompensatorStore).listCompensators === "function" &&
    typeof (v as CompensatorStore).upsertCompensator === "function"
  );
}

export class CompensatorRegistry {
  private memory = new Map<string, CompensatorRow>();
  private store?: CompensatorStore;
  private now: () => Date;
  private hosted: boolean;

  constructor(opts?: { ledger?: unknown; now?: () => Date; hosted?: boolean }) {
    this.now = opts?.now ?? (() => new Date());
    if (hasStore(opts?.ledger)) this.store = opts.ledger;
    const kind =
      opts?.ledger && typeof opts.ledger === "object" && "kind" in opts.ledger
        ? String((opts.ledger as { kind?: unknown }).kind)
        : undefined;
    this.hosted = opts?.hosted ?? (kind === "http" || hostedModeActive());
  }

  get hostedMode(): boolean {
    return this.hosted;
  }

  async hydrate(): Promise<void> {
    if (!this.store) return;
    const rows = await this.store.listCompensators();
    for (const row of rows) this.memory.set(row.id, row);
  }

  async register(m: ActionSignature | ActionSignature[], opts?: RegisterOpts): Promise<RegisterResult> {
    const list = Array.isArray(m) ? m : [m];
    const ids: string[] = [];
    const rows: CompensatorRow[] = [];
    for (const sig of list) {
      const g =
        sig.compensator.kind === "declarative"
          ? gateDeclarativeManifest(sig, { now: this.now() })
          : await gateManifest(sig, { now: this.now() });
      if (!g.ok) return { ok: false, ids: [], error_code: g.error_code, detail: g.detail };
      if (this.hosted && g.signature.source === "registered") {
        if (!g.signature.signature) {
          return { ok: false, ids: [], error_code: "VR6003", detail: "hosted register requires ActionSignature.signature" };
        }
        if (!verifyManifestSignature(g.signature)) {
          return { ok: false, ids: [], error_code: "VR6003", detail: "bad_signature" };
        }
      }
      if (!opts?.force && this.memory.has(g.signature.id)) {
        return { ok: false, ids: [], error_code: "VR3005", detail: `already registered: ${g.signature.id}` };
      }
      const row = toRow(g.signature, this.now().toISOString());
      this.memory.set(row.id, row);
      rows.push(row);
      ids.push(row.id);
    }
    if (this.store) {
      for (const row of rows) await this.store.upsertCompensator(row);
    }
    return { ok: true, ids };
  }

  async list(): Promise<ActionSignature[]> {
    await this.hydrate();
    return [...this.memory.values()]
      .filter((r) => !r.disabled)
      .sort((a, b) => (a.registered_at < b.registered_at ? -1 : a.registered_at > b.registered_at ? 1 : a.id.localeCompare(b.id)))
      .map((r) => r.manifest);
  }

  match(action: ActionRef, args: JsonValue, result?: JsonValue): MatchResult {
    const registry = [...this.memory.values()]
      .filter((r) => !r.disabled)
      .map((r) => r.manifest)
      .filter((m) => !this.hosted || m.source === "builtin" || verifyManifestSignature(m));
    const r = matchCompensator(registry, action, args, result);
    return { matched: r.matched, candidates: r.candidates };
  }

  async get(id: string): Promise<ActionSignature | undefined> {
    await this.hydrate();
    return this.memory.get(id)?.manifest;
  }

  async verify(opts?: { strict?: boolean }): Promise<{ ok: boolean; error_code?: VRCode; detail?: string; ids: string[] }> {
    await this.hydrate();
    const ids: string[] = [];
    for (const row of this.memory.values()) {
      const g = await gateManifest(row.manifest, { now: this.now() });
      if (!g.ok) return { ok: false, error_code: g.error_code, detail: g.detail, ids };
      if ((opts?.strict || this.hosted) && row.manifest.source === "registered") {
        if (row.manifest.signature && !verifyManifestSignature(row.manifest)) {
          return { ok: false, error_code: "VR6003", detail: `bad_signature ${row.id}`, ids };
        }
        if (this.hosted && !row.manifest.signature) {
          return { ok: false, error_code: "VR6003", detail: `unsigned hosted manifest ${row.id}`, ids };
        }
      }
      ids.push(row.id);
    }
    return { ok: true, ids };
  }
}

export function gateDeclarativeManifest(sig: ActionSignature, opts?: { now?: Date }): GateResult {
  const schema = validateManifestSchema(sig);
  if (schema) return { ok: false, error_code: "VR3005", detail: schema };
  if (sig.source === "drafted") {
    return { ok: false, error_code: "VR4005", detail: "drafted_not_allowed" };
  }
  if (sig.compensator.kind !== "declarative") {
    return { ok: false, error_code: "VR3005", detail: "expected declarative" };
  }
  const names = assertNameResolution(sig);
  if (names) return names;
  const receipt = syntheticReceiptFromSignature(sig);
  const compiled = compilePlan(receipt, sig, { origin: sig.source, now: opts?.now });
  if (isPlanRejection(compiled)) {
    return { ok: false, error_code: compiled.error_code, detail: compiled.detail };
  }
  return { ok: true, signature: { ...sig, registered_at: sig.registered_at ?? opts?.now?.toISOString() }, plan: compiled };
}

export async function gateManifest(sig: ActionSignature, opts?: { now?: Date }): Promise<GateResult> {
  if (sig.compensator.kind === "declarative") return gateDeclarativeManifest(sig, opts);

  const schema = validateManifestSchema(sig);
  if (schema) return { ok: false, error_code: "VR3005", detail: schema };

  if (sig.source === "drafted") {
    return { ok: false, error_code: "VR4005", detail: "drafted_not_allowed" };
  }

  const names = assertNameResolution(sig);
  if (names) return names;

  const receipt = syntheticReceiptFromSignature(sig);
  let lowered = sig;
  if (sig.compensator.kind === "programmatic") {
    const purity = await assertPureCompensator(sig, receipt);
    if (!purity.ok) return purity;
    lowered = {
      ...sig,
      compensator: { kind: "declarative", steps: purity.steps, postconditions: purity.postconditions },
    };
  }

  const compiled = compilePlan(receipt, lowered, { origin: sig.source, now: opts?.now });
  if (isPlanRejection(compiled)) {
    return { ok: false, error_code: compiled.error_code, detail: compiled.detail };
  }
  return { ok: true, signature: { ...sig, registered_at: sig.registered_at ?? opts?.now?.toISOString() }, plan: compiled };
}

export function syntheticReceiptFromSignature(sig: ActionSignature, overlay?: Partial<EffectReceipt>): EffectReceipt {
  const bindings: Record<string, JsonValue> = {};
  const result: Record<string, JsonValue> = { status: 200 };
  const args: Record<string, JsonValue> = {};
  const headers: Record<string, string> = {};

  if (sig.match.kind === "http") {
    args.method = firstOf(sig.match.method);
    args.url = staticUrl(sig.match.url_pattern);
  } else if (sig.match.kind === "sql") {
    args.statement = firstOf(sig.match.statement);
    args.table = sig.match.table === "*" ? "t" : sig.match.table;
    if (sig.match.dialect) args.dialect = sig.match.dialect;
  } else if (sig.match.kind === "fs") {
    args.op = firstOf(sig.match.op);
    args.path = sig.match.path_glob.replace(/\*\*/g, "x").replace(/\*/g, "x") || "/x";
    args.realpath = args.path;
  } else if (sig.match.kind === "mcp_tool") {
    args.tool = sig.match.tool;
    if (sig.match.version) args.version = sig.match.version.replace(/^[\^~>=<]+/, "").replace(/\.x$|\.\*$/, ".0.0");
  } else if (sig.match.kind === "shell") {
    args.argv = sig.match.argv_template.map((s) => (s === "{}" ? "x" : s));
  } else if (sig.match.kind === "sdk_fn") {
    args.module = sig.match.module;
    args.fn = sig.match.fn;
  }

  for (const [name, ex] of Object.entries(sig.binds ?? {})) {
    const sample = sampleBinding(name, ex.pattern);
    bindings[name] = sample;
    if (ex.from === "status") {
      result.status = typeof sample === "number" ? sample : 200;
    } else if (ex.from.startsWith("result.")) {
      setFromSelector(result, ex.from.slice("result.".length), sample);
    } else if (ex.from.startsWith("args.")) {
      setFromSelector(args, ex.from.slice("args.".length), sample);
    } else if (ex.from.startsWith("header.")) {
      const h = ex.from.slice("header.".length);
      headers[h] = String(sample);
    }
  }

  if (Object.keys(headers).length) args.headers = headers as unknown as JsonValue;

  const kind = matchKindToAction(sig.match.kind);
  const action: ActionRef = {
    kind,
    name: actionNameFromMatch(sig),
    target: targetFromMatch(sig, args),
    locality: "external",
  };
  const keys = resourceKeys({
    action,
    bindings,
    args,
    result,
    headers,
    dialect: typeof args.dialect === "string" ? args.dialect : undefined,
    table: typeof args.table === "string" ? args.table : undefined,
    realpath: typeof args.realpath === "string" ? args.realpath : undefined,
    mcpTool: typeof args.tool === "string" ? args.tool : undefined,
  });

  const receipt: EffectReceipt = {
    v: "vekrevert/v1",
    effect_id: "eff_synthetic",
    saga_id: "sag_synthetic",
    seq: 1,
    action,
    tier: sig.tier,
    classification: { tier: sig.tier, sources: [], reasons: [], candidates: [], scope_violation: false },
    args_observed: args,
    args_hash: "sha256:synthetic",
    intent_key: "sha256:synthetic",
    result_observed: result,
    bindings,
    binding_paths: Object.fromEntries(Object.entries(sig.binds ?? {}).map(([k, v]) => [k, v.from])),
    resource_keys: keys,
    status: "landed",
    compensation_state: "available",
    capture: { fidelity: "full", interceptor: "synthetic", sdk_version: "0.1.0", warnings: [] },
    leak: sig.leak,
    cascade_risk: sig.cascade_risk,
    opened_at: "1970-01-01T00:00:00.000Z",
    closed_at: "1970-01-01T00:00:00.000Z",
    redactions: [],
    sealed: true,
    preimage: sig.preimage
      ? { kind: sig.preimage.kind, truncated: false, blob_id: sig.preimage.kind === "fs_bytes" ? "blob_synthetic" : undefined }
      : undefined,
    ...overlay,
  };
  return receipt;
}

async function assertPureCompensator(
  sig: ActionSignature,
  receipt: EffectReceipt,
): Promise<GateErr | { ok: true; steps: CompensationStep[]; postconditions?: CompensationPlan["postconditions"] }> {
  if (sig.compensator.kind !== "programmatic") {
    return { ok: false, error_code: "VR3005", detail: "expected programmatic" };
  }
  const fn = await loadProgrammatic(sig.compensator.module, sig.compensator.export);
  let a: CompensationPlan;
  let b: CompensationPlan;
  try {
    a = await Promise.resolve(fn(receipt));
    b = await Promise.resolve(fn(receipt));
  } catch (err) {
    return { ok: false, error_code: "VR3012", detail: err instanceof Error ? err.message : String(err) };
  }
  const ha = planHash({ effect_id: receipt.effect_id, compensator_id: sig.id, origin: sig.source, steps: a.steps });
  const hb = planHash({ effect_id: receipt.effect_id, compensator_id: sig.id, origin: sig.source, steps: b.steps });
  if (ha !== hb) return { ok: false, error_code: "VR3012", detail: "impure_compensator" };
  return { ok: true, steps: a.steps, postconditions: a.postconditions };
}

async function loadProgrammatic(
  modulePath: string,
  exportName?: string,
): Promise<(receipt: EffectReceipt) => CompensationPlan | Promise<CompensationPlan>> {
  const href = pathToFileURL(resolve(modulePath)).href;
  const mod = (await import(href)) as Record<string, unknown>;
  const fn = mod[exportName ?? "default"];
  if (typeof fn !== "function") throw new Error(`programmatic export '${exportName ?? "default"}' is not a function`);
  return fn as (receipt: EffectReceipt) => CompensationPlan | Promise<CompensationPlan>;
}

function validateManifestSchema(sig: ActionSignature): string | null {
  if (!sig.id || typeof sig.id !== "string") return "id required";
  if (!sig.match || typeof sig.match !== "object") return "match required";
  if (!sig.tier) return "tier required";
  if (!sig.compensator || typeof sig.compensator !== "object") return "compensator required";
  if (sig.compensator.kind !== "declarative" && sig.compensator.kind !== "programmatic") {
    return "compensator.kind must be declarative|programmatic";
  }
  if (sig.compensator.kind === "declarative") {
    if (!Array.isArray(sig.compensator.steps)) return "compensator.steps required";
    for (const step of sig.compensator.steps) {
      if (!step || typeof step !== "object" || !("kind" in step)) return "invalid step";
    }
  }
  if (sig.compensator.kind === "programmatic" && !sig.compensator.module) return "programmatic module required";
  if (!sig.leak) return "leak required";
  if (!sig.cascade_risk) return "cascade_risk required";
  if (!sig.reversal_completeness) return "reversal_completeness required";
  if (!sig.source) return "source required";
  if (sig.source !== "builtin" && sig.source !== "registered" && sig.source !== "drafted") return "source invalid";
  if (!sig.binds) return "binds required";
  return null;
}

function assertNameResolution(sig: ActionSignature): GateErr | null {
  const steps = sig.compensator.kind === "declarative" ? sig.compensator.steps : [];
  const constNames = new Set(Object.keys(sig.constants ?? {}));
  const credNames = new Set(sig.credentials ?? []);
  let err: GateErr | null = null;
  const walk = (v: unknown): void => {
    if (err) return;
    if (isRef(v)) {
      if (v.$ref.startsWith("const.")) {
        const name = v.$ref.slice("const.".length);
        if (!constNames.has(name)) err = { ok: false, error_code: "VR3006", detail: `unresolvable_ref ${v.$ref}` };
      }
      if (v.$ref.startsWith("credential.")) {
        const name = v.$ref.slice("credential.".length);
        if (!credNames.has(name)) err = { ok: false, error_code: "VR3006", detail: `unresolvable_ref ${v.$ref}` };
      }
    } else if (typeof v === "string") {
      const bearer = v.match(/^(Bearer|Basic|Token)\s+\{\s*\$ref:\s*"([^"]+)"\s*\}$/i);
      if (bearer) walk({ $ref: bearer[2] });
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as object).forEach(walk);
  };
  walk(steps);
  return err;
}

function toRow(sig: ActionSignature, registered_at: string): CompensatorRow {
  const manifest = { ...sig, source: sig.source ?? "registered", registered_at };
  return {
    id: manifest.id,
    manifest,
    source: manifest.source,
    match_kind: manifest.match.kind,
    specificity: specificityScore(manifest),
    signature: manifest.signature,
    registered_at,
    disabled: manifest.disabled ? 1 : 0,
  };
}

function sampleBinding(name: string, pattern?: string): JsonValue {
  if (pattern) {
    if (pattern.includes("ch_")) return "ch_0";
    if (pattern.startsWith("^") && pattern.includes("[A-Za-z0-9]")) {
      const prefix = pattern.match(/\^([A-Za-z0-9_]+)/)?.[1] ?? "x";
      return `${prefix}0`;
    }
    if (pattern === "^\\d+$" || pattern === "^[0-9]+$") return 1;
  }
  if (/url/i.test(name)) return "https://example.invalid/x";
  if (/^(path|from|to|realpath)$/.test(name)) return "/x";
  if (/amount|count|qty|n$/.test(name)) return 1;
  return `bind_${name}`;
}

function firstOf<T extends string>(v: T | T[]): T {
  return Array.isArray(v) ? (v[0] as T) : v;
}

function setFromSelector(obj: Record<string, JsonValue>, selector: string, value: JsonValue): void {
  let p = selector;
  if (p.startsWith("$.")) p = p.slice(2);
  else if (p.startsWith("$")) p = p.slice(1);
  const parts = p.split(".").filter(Boolean);
  let cur: Record<string, JsonValue> = obj;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i]!;
    if (i === parts.length - 1) cur[key] = value;
    else {
      const next = cur[key];
      if (!next || typeof next !== "object" || Array.isArray(next)) cur[key] = {};
      cur = cur[key] as Record<string, JsonValue>;
    }
  }
}

function staticUrl(pattern: string): string {
  if (pattern === "*" || pattern === "**" || pattern === "*://*/**") return "https://example.invalid/x";
  return pattern.replace(/\{[^}]+\}/g, "id").replace(/\*/g, "x");
}

function matchKindToAction(kind: ActionSignature["match"]["kind"]): ActionRef["kind"] {
  if (kind === "*" || kind === "mcp_tool") return kind === "*" ? "sdk_fn" : "mcp_tool";
  return kind;
}

function actionNameFromMatch(sig: ActionSignature): string {
  const m = sig.match;
  switch (m.kind) {
    case "http": {
      const u = staticUrl(m.url_pattern);
      const method = firstOf(m.method);
      try {
        const url = new URL(u);
        return `http.${method}.${url.hostname}${url.pathname}`;
      } catch {
        return `http.${method}.unknown`;
      }
    }
    case "sql":
      return `sql.${firstOf(m.statement)}.app.${m.table === "*" ? "t" : m.table}`;
    case "fs":
      return `fs.${firstOf(m.op)}.${m.path_glob}`;
    case "mcp_tool":
      return `mcp.server.${m.tool}`;
    case "sdk_fn":
      return `sdk.${m.module}.${m.fn}`;
    case "shell":
      return `shell.${m.argv_template[0] ?? "sh"}`;
    case "*":
      return "unknown";
  }
}

function targetFromMatch(sig: ActionSignature, args: Record<string, JsonValue>): string | undefined {
  if (sig.match.kind === "http" && typeof args.url === "string") {
    try {
      return new URL(args.url).hostname;
    } catch {
      return undefined;
    }
  }
  if (sig.match.kind === "sql") return "app";
  if (sig.match.kind === "fs" && typeof args.realpath === "string") return args.realpath;
  return undefined;
}

void VekRevertError;
