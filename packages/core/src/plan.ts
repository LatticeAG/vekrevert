/** Plan compiler: provenance, scope, closed step set (§4.4, §4.5, §6.3, §7.2). */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { derivePlanHash } from "./chain.ts";
import { evalJsonPath } from "./jsonpath.ts";
import { normalizeHttpUrl } from "./resource.ts";
import type {
  ActionSignature,
  ArgValue,
  CompensationPlan,
  CompensationStep,
  EffectReceipt,
  JsonValue,
  PlanRejection,
  Ref,
  RefSource,
} from "./types.ts";
import { DEFAULT_LIMITS } from "./types.ts";

const STEP_KINDS = new Set([
  "http_request",
  "sql_statement",
  "fs_restore",
  "fs_rename",
  "mcp_tool_call",
  "noop",
  "manual",
]);

const HTTP_METHODS = new Set(["DELETE", "POST", "PATCH", "PUT"]);
const SQL_STATEMENTS = new Set(["INSERT", "UPDATE", "DELETE"]);
const SQL_DIALECTS = new Set(["sqlite", "postgres", "mysql", "unknown"]);
const SQL_TEXT_KEYS = new Set(["sql", "query", "text", "raw", "raw_sql", "command", "script"]);

const HTTP_KEYS = new Set(["kind", "method", "url", "headers", "body", "expect"]);
const SQL_KEYS = new Set(["kind", "dialect", "statement", "table", "where", "set", "values", "expect_rowcount"]);
const FS_RESTORE_KEYS = new Set(["kind", "path", "source", "restore_meta"]);
const FS_RENAME_KEYS = new Set(["kind", "from", "to"]);
const MCP_KEYS = new Set(["kind", "tool", "args", "expect"]);
const NOOP_KEYS = new Set(["kind", "reason"]);
const MANUAL_KEYS = new Set(["kind", "instructions", "suggested_actions"]);

export type CompilePlanOpts = {
  origin?: CompensationPlan["origin"];
  now?: Date;
  plan_id?: string;
  steps?: CompensationStep[];
};

export function compilePlan(
  receipt: EffectReceipt,
  signature: ActionSignature,
  opts?: CompilePlanOpts,
): CompensationPlan | PlanRejection {
  const origin = opts?.origin ?? signature.source;
  const now = opts?.now ?? new Date();
  if (receipt.compensable_until) {
    const until = Date.parse(receipt.compensable_until);
    if (!Number.isNaN(until) && until < now.getTime()) {
      return reject("VR5007", "compile", "window_expired");
    }
  }
  const rawSteps = opts?.steps ?? (signature.compensator.kind === "declarative" ? signature.compensator.steps : undefined);
  if (!rawSteps) {
    return reject("VR3005", "schema", "programmatic compensator must be lowered to declarative steps before compilePlan");
  }

  const steps = expandHeaderTemplates(rawSteps) as CompensationStep[];

  const schemaErr = validateClosedStepSet(steps);
  if (schemaErr) return reject("VR3005", "schema", schemaErr);

  const prov = assertProvenance(steps);
  if (prov) return prov;

  if (origin === "drafted" && hasConstRef(steps)) {
    return reject("VR3010", "compile", "drafted plans may not use const.* refs");
  }

  const resolved = resolveSteps(steps, receipt, signature, origin);
  if (!resolved.ok) return resolved.rejection;

  const cred = assertCredentialPositions(steps);
  if (cred) return cred;

  const unsafe = assertUnsafeStatements(steps, resolved.values, receipt);
  if (unsafe) return unsafe;

  const scope = assertScope(steps, resolved.values, receipt, signature, origin);
  if (scope) return scope;

  if (steps.length > (DEFAULT_LIMITS.maxPlanSteps ?? 8)) {
    return reject("VR3011", "compile", `plan has ${steps.length} steps; max is ${DEFAULT_LIMITS.maxPlanSteps}`);
  }

  const keys = mutatingResourceKeys(steps, resolved.values, receipt, signature);
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) return reject("VR3011", "compile", `more than one mutating step for resource_key ${k}`);
    seen.add(k);
  }

  const created_at = now.toISOString();
  const plan_id = opts?.plan_id ?? "cpl_pending";
  const hash = planHash({
    effect_id: receipt.effect_id,
    compensator_id: signature.id,
    origin,
    steps,
  });

  const plan: CompensationPlan = {
    v: "vekrevert/v1",
    plan_id,
    effect_id: receipt.effect_id,
    saga_id: receipt.saga_id,
    compensator_id: signature.id,
    origin,
    steps,
    plan_hash: hash,
    postconditions: signature.compensator.kind === "declarative" ? (signature.compensator.postconditions ?? []) : [],
    reversal_completeness: signature.reversal_completeness,
    leak: signature.leak,
    cascade_risk: signature.cascade_risk,
    summary: summarize(steps),
    created_at,
  };
  return plan;
}

export function planHash(input: {
  effect_id: string;
  compensator_id: string;
  origin: string;
  steps: CompensationStep[] | JsonValue;
}): string {
  return derivePlanHash({
    effect_id: input.effect_id,
    compensator_id: input.compensator_id,
    origin: input.origin,
    steps: input.steps as JsonValue,
  });
}

export function assertProvenance(steps: CompensationStep[]): PlanRejection | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const positions = argPositions(step);
    for (const pos of positions) {
      const err = assertArgValue(pos.value, `steps[${i}].${pos.path}`);
      if (err) return err;
    }
  }
  return null;
}

export function resolveRef(
  ref: Ref,
  receipt: EffectReceipt,
  signature?: ActionSignature,
  origin?: CompensationPlan["origin"],
): { ok: true; value: JsonValue | Ref } | { ok: false; rejection: PlanRejection } {
  const src = ref.$ref;
  if (!isRefSource(src)) {
    return { ok: false, rejection: reject("VR3006", "provenance", `unresolvable_ref ${src}`) };
  }
  if (src.startsWith("credential.")) {
    return { ok: true, value: ref };
  }
  if (src === "runtime.idempotency_key") {
    return { ok: true, value: ref };
  }
  if (src.startsWith("const.")) {
    if (origin === "drafted") {
      return { ok: false, rejection: reject("VR3010", "compile", src) };
    }
    const name = src.slice("const.".length);
    const constants = signature?.constants ?? {};
    if (!(name in constants)) {
      return { ok: false, rejection: reject("VR3006", "provenance", `unresolvable_ref ${src}`) };
    }
    return { ok: true, value: constants[name]! };
  }
  if (src === "receipt.preimage.blob") {
    if (!receipt.preimage || receipt.preimage.kind === "none" || receipt.preimage.kind === "fs_absent") {
      return { ok: false, rejection: reject("VR3006", "provenance", src) };
    }
    return { ok: true, value: receipt.preimage.blob_id ?? "receipt.preimage.blob" };
  }
  if (src === "receipt.preimage.absent") {
    return { ok: true, value: "absent" };
  }
  if (src.startsWith("receipt.bindings.")) {
    const name = src.slice("receipt.bindings.".length);
    const v = receipt.bindings[name];
    if (v === undefined) return { ok: false, rejection: reject("VR3006", "provenance", src) };
    return { ok: true, value: v };
  }
  if (src.startsWith("receipt.args.")) {
    const path = src.slice("receipt.args.".length);
    try {
      const v = evalJsonPath(receipt.args_observed, path);
      if (v === undefined) return { ok: false, rejection: reject("VR3006", "provenance", src) };
      return { ok: true, value: v };
    } catch (err) {
      return { ok: false, rejection: reject("VR3006", "provenance", `${src}: ${err instanceof Error ? err.message : String(err)}`) };
    }
  }
  if (src.startsWith("receipt.result.")) {
    const path = src.slice("receipt.result.".length);
    try {
      const v = evalJsonPath(receipt.result_observed, path);
      if (v === undefined) return { ok: false, rejection: reject("VR3006", "provenance", src) };
      return { ok: true, value: v };
    } catch (err) {
      return { ok: false, rejection: reject("VR3006", "provenance", `${src}: ${err instanceof Error ? err.message : String(err)}`) };
    }
  }
  return { ok: false, rejection: reject("VR3006", "provenance", src) };
}

export function assertScope(
  steps: CompensationStep[],
  resolved: JsonValue[],
  receipt: EffectReceipt,
  signature: ActionSignature,
  origin: CompensationPlan["origin"],
): PlanRejection | null {
  const keys = receipt.resource_keys ?? [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const value = resolved[i];
    if (value === undefined) return reject("VR3006", "scope", `steps[${i}] unresolved`);
    const err = assertStepScope(step, value, receipt, signature, origin, keys);
    if (err) return err;
  }
  return null;
}

export function assertCredentialPositions(steps: CompensationStep[]): PlanRejection | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const err = walkCredentials(step, i);
    if (err) return err;
  }
  return null;
}

export function isRef(v: unknown): v is Ref {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec.$ref !== "string") return false;
  const keys = Object.keys(rec);
  return keys.length === 1 && keys[0] === "$ref";
}

export function isPlanRejection(v: CompensationPlan | PlanRejection): v is PlanRejection {
  return (v as PlanRejection).ok === false;
}

function reject(code: PlanRejection["error_code"], stage: PlanRejection["stage"], detail: string): PlanRejection {
  return { ok: false, error_code: code, stage, detail };
}

function validateClosedStepSet(steps: unknown): string | null {
  if (!Array.isArray(steps)) return "steps must be an array";
  if (steps.length === 0) return "plan must contain at least one step";
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== "object" || Array.isArray(step)) return `steps[${i}] is not an object`;
    const rec = step as Record<string, unknown>;
    const kind = rec.kind;
    if (typeof kind !== "string" || !STEP_KINDS.has(kind)) {
      return `steps[${i}] kind is not in the closed set`;
    }
    const extra = unknownKeys(rec, allowedKeys(kind));
    if (extra.length) return `steps[${i}] unknown fields: ${extra.join(",")}`;
    const sqlText = Object.keys(rec).filter((k) => SQL_TEXT_KEYS.has(k));
    if (kind === "sql_statement" && sqlText.length) {
      return `steps[${i}] declarative sql_statement cannot carry SQL text`;
    }
    if (kind === "http_request") {
      if (!HTTP_METHODS.has(String(rec.method))) return `steps[${i}] http method not allowed`;
      if (rec.url === undefined) return `steps[${i}] url required`;
      if (!rec.expect || typeof rec.expect !== "object") return `steps[${i}] expect required`;
    }
    if (kind === "sql_statement") {
      if (!SQL_DIALECTS.has(String(rec.dialect))) return `steps[${i}] dialect invalid`;
      if (typeof rec.statement !== "string" || !SQL_STATEMENTS.has(rec.statement)) {
        return `steps[${i}] statement must be INSERT|UPDATE|DELETE, not SQL text`;
      }
      if (rec.statement.includes(";") || rec.statement.includes(" ")) {
        return `steps[${i}] statement must be INSERT|UPDATE|DELETE, not SQL text`;
      }
      if (rec.table === undefined) return `steps[${i}] table required`;
      if (!rec.expect_rowcount || typeof rec.expect_rowcount !== "object") return `steps[${i}] expect_rowcount required`;
    }
    if (kind === "fs_restore") {
      if (rec.path === undefined) return `steps[${i}] path required`;
      if (rec.source === undefined) return `steps[${i}] source required`;
    }
    if (kind === "fs_rename") {
      if (rec.from === undefined || rec.to === undefined) return `steps[${i}] from and to required`;
    }
    if (kind === "mcp_tool_call") {
      if (rec.tool === undefined) return `steps[${i}] tool required`;
      if (rec.args === undefined) return `steps[${i}] args required`;
    }
    if (kind === "noop" && typeof rec.reason !== "string") return `steps[${i}] reason required`;
    if (kind === "manual") {
      if (typeof rec.instructions !== "string") return `steps[${i}] instructions required`;
      if (!Array.isArray(rec.suggested_actions)) return `steps[${i}] suggested_actions required`;
    }
  }
  return null;
}

function allowedKeys(kind: string): Set<string> {
  switch (kind) {
    case "http_request":
      return HTTP_KEYS;
    case "sql_statement":
      return SQL_KEYS;
    case "fs_restore":
      return FS_RESTORE_KEYS;
    case "fs_rename":
      return FS_RENAME_KEYS;
    case "mcp_tool_call":
      return MCP_KEYS;
    case "noop":
      return NOOP_KEYS;
    case "manual":
      return MANUAL_KEYS;
    default:
      return new Set(["kind"]);
  }
}

function unknownKeys(rec: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(rec).filter((k) => !allowed.has(k));
}

type ArgPos = { path: string; value: unknown };

function argPositions(step: CompensationStep): ArgPos[] {
  switch (step.kind) {
    case "http_request": {
      const out: ArgPos[] = [{ path: "url", value: step.url }];
      if (step.headers) {
        for (const [k, v] of Object.entries(step.headers)) out.push({ path: `headers.${k}`, value: v });
      }
      if (step.body !== undefined) out.push({ path: "body", value: step.body });
      return out;
    }
    case "sql_statement": {
      const out: ArgPos[] = [{ path: "table", value: step.table }];
      if (step.where) for (const [k, v] of Object.entries(step.where)) out.push({ path: `where.${k}`, value: v });
      if (step.set) for (const [k, v] of Object.entries(step.set)) out.push({ path: `set.${k}`, value: v });
      if (step.values) for (const [k, v] of Object.entries(step.values)) out.push({ path: `values.${k}`, value: v });
      return out;
    }
    case "fs_restore":
      return [
        { path: "path", value: step.path },
        { path: "source", value: step.source },
      ];
    case "fs_rename":
      return [
        { path: "from", value: step.from },
        { path: "to", value: step.to },
      ];
    case "mcp_tool_call":
      return [
        { path: "tool", value: step.tool },
        { path: "args", value: step.args },
      ];
    case "noop":
    case "manual":
      return [];
  }
}

function assertArgValue(v: unknown, path: string): PlanRejection | null {
  if (v === undefined) return reject("VR3007", "provenance", `${path}: missing`);
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return reject("VR3007", "provenance", `${path}: unprovenanced_literal`);
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const err = assertArgValue(v[i], `${path}[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if ("$ref" in rec) {
      if (!isRef(v)) return reject("VR3007", "provenance", `${path}: malformed ref`);
      if (!isRefSource(rec.$ref as string)) return reject("VR3006", "provenance", `${path}: unresolvable_ref ${rec.$ref}`);
      return null;
    }
    for (const [k, val] of Object.entries(rec)) {
      const err = assertArgValue(val, `${path}.${k}`);
      if (err) return err;
    }
    return null;
  }
  return reject("VR3007", "provenance", `${path}: unprovenanced_literal`);
}

function isRefSource(s: string): s is RefSource {
  if (s === "receipt.preimage.blob" || s === "receipt.preimage.absent" || s === "runtime.idempotency_key") return true;
  return (
    s.startsWith("receipt.bindings.") ||
    s.startsWith("receipt.args.") ||
    s.startsWith("receipt.result.") ||
    s.startsWith("const.") ||
    s.startsWith("credential.")
  );
}

function hasConstRef(steps: CompensationStep[]): boolean {
  let found = false;
  const walk = (v: unknown): void => {
    if (isRef(v) && v.$ref.startsWith("const.")) found = true;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as object).forEach(walk);
  };
  for (const s of steps) walk(s);
  return found;
}

type ResolveOk = { ok: true; values: JsonValue[] };

function resolveSteps(
  steps: CompensationStep[],
  receipt: EffectReceipt,
  signature: ActionSignature,
  origin: CompensationPlan["origin"],
): ResolveOk | { ok: false; rejection: PlanRejection } {
  const values: JsonValue[] = [];
  for (const step of steps) {
    const resolved = resolveDeep(step as unknown as JsonValue, receipt, signature, origin);
    if (!resolved.ok) return resolved;
    values.push(resolved.value);
  }
  return { ok: true, values };
}

function resolveDeep(
  v: JsonValue,
  receipt: EffectReceipt,
  signature: ActionSignature,
  origin: CompensationPlan["origin"],
): { ok: true; value: JsonValue } | { ok: false; rejection: PlanRejection } {
  if (isRef(v)) {
    const r = resolveRef(v, receipt, signature, origin);
    if (!r.ok) return r;
    return { ok: true, value: r.value as JsonValue };
  }
  if (Array.isArray(v)) {
    const out: JsonValue[] = [];
    for (const item of v) {
      const r = resolveDeep(item, receipt, signature, origin);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (v && typeof v === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, val] of Object.entries(v)) {
      const r = resolveDeep(val as JsonValue, receipt, signature, origin);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value: v };
}

function walkCredentials(step: CompensationStep, index: number): PlanRejection | null {
  const check = (v: unknown, pos: "header" | "mcp_args" | "forbidden", path: string): PlanRejection | null => {
    if (isRef(v)) {
      if (v.$ref.startsWith("credential.") && pos === "forbidden") {
        return reject("VR3009", "compile", `steps[${index}].${path}: credential.* not allowed here`);
      }
      return null;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const err = check(v[i], pos, `${path}[${i}]`);
        if (err) return err;
      }
      return null;
    }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const err = check(val, pos, `${path}.${k}`);
        if (err) return err;
      }
    }
    return null;
  };

  switch (step.kind) {
    case "http_request": {
      const u = check(step.url, "forbidden", "url");
      if (u) return u;
      if (step.body) {
        const b = check(step.body, "forbidden", "body");
        if (b) return b;
      }
      if (step.headers) {
        const h = check(step.headers, "header", "headers");
        if (h) return h;
      }
      return null;
    }
    case "sql_statement":
      return (
        check(step.table, "forbidden", "table") ||
        check(step.where, "forbidden", "where") ||
        check(step.set, "forbidden", "set") ||
        check(step.values, "forbidden", "values")
      );
    case "fs_restore":
      return check(step.path, "forbidden", "path") || check(step.source, "forbidden", "source");
    case "fs_rename":
      return check(step.from, "forbidden", "from") || check(step.to, "forbidden", "to");
    case "mcp_tool_call":
      return check(step.tool, "forbidden", "tool") || check(step.args, "mcp_args", "args");
    default:
      return null;
  }
}

function assertUnsafeStatements(
  steps: CompensationStep[],
  resolved: JsonValue[],
  receipt: EffectReceipt,
): PlanRejection | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const rec = asRecord(resolved[i]);
    if (step.kind === "sql_statement") {
      const table = stringify(rec.table);
      if (table.includes(";") || looksLikeSql(table)) {
        return reject("VR3009", "compile", `steps[${i}].table carries SQL text`);
      }
      const statement = step.statement;
      if (statement === "UPDATE" || statement === "DELETE") {
        const where = rec.where;
        if (!where || typeof where !== "object" || Array.isArray(where) || Object.keys(where as object).length === 0) {
          return reject("VR3009", "compile", `steps[${i}] bare WHERE`);
        }
        const whereKeys = Object.keys(where as object);
        if (whereKeys.some((k) => k === "true" || k === "1" || k.toLowerCase() === "true")) {
          return reject("VR3009", "compile", `steps[${i}] WHERE true`);
        }
      }
      for (const slot of ["where", "set", "values"] as const) {
        const bag = rec[slot];
        if (bag && typeof bag === "object") {
          for (const [k, val] of Object.entries(bag as Record<string, JsonValue>)) {
            const s = stringify(val);
            if (s.includes(";") || looksLikeSql(s) || looksLikeSql(k)) {
              return reject("VR3009", "compile", `steps[${i}].${slot} carries SQL text`);
            }
          }
        }
      }
    }
    if (step.kind === "fs_restore") {
      const src = step.source;
      if (isRef(src) && src.$ref === "receipt.preimage.blob") {
        if (!receipt.preimage || receipt.preimage.truncated || receipt.preimage.kind === "fs_absent" || receipt.preimage.kind === "none") {
          return reject("VR3009", "compile", "DELETE-without-preimage");
        }
      }
    }
    if (step.kind === "http_request" && step.method === "DELETE") {
      if (receipt.action.kind === "http") {
        const method = httpMethodOf(receipt);
        if (method === "DELETE" && (!receipt.preimage || receipt.preimage.kind === "none")) {
          return reject("VR3009", "compile", "DELETE-without-preimage");
        }
      }
    }
  }
  return null;
}

function assertStepScope(
  step: CompensationStep,
  resolved: JsonValue,
  receipt: EffectReceipt,
  signature: ActionSignature,
  origin: CompensationPlan["origin"],
  keys: string[],
): PlanRejection | null {
  const rec = asRecord(resolved);
  switch (step.kind) {
    case "http_request":
      return assertHttpScope(stringify(rec.url), receipt, signature, origin, keys);
    case "sql_statement":
      return assertSqlScope(step, rec, receipt, keys);
    case "fs_restore":
      return assertFsScope(stringify(rec.path), receipt, keys, "single");
    case "fs_rename":
      return assertFsRenameScope(stringify(rec.from), stringify(rec.to), receipt, keys);
    case "mcp_tool_call":
      return assertMcpScope(step, rec, signature);
    case "noop":
    case "manual":
      return null;
  }
}

function inspectRawHttpHost(url: string): { userinfo: boolean; host: string } {
  const m = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/);
  if (!m) return { userinfo: false, host: "" };
  const authority = m[1] ?? "";
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    const hostport = authority.slice(at + 1);
    const host = hostport.startsWith("[") ? hostport : hostport.split(":")[0] ?? "";
    return { userinfo: true, host };
  }
  const host = authority.startsWith("[") ? authority : authority.split(":")[0] ?? "";
  return { userinfo: false, host };
}

function assertHttpScope(
  url: string,
  receipt: EffectReceipt,
  signature: ActionSignature,
  origin: CompensationPlan["origin"],
  keys: string[],
): PlanRejection | null {
  if (!url) return reject("VR3008", "scope", "http url empty");
  const raw = inspectRawHttpHost(url);
  if (raw.userinfo) return reject("VR3008", "scope", "url userinfo");
  if (raw.host.endsWith(".")) return reject("VR3008", "scope", "trailing-dot host");
  if (raw.host !== raw.host.toLowerCase()) return reject("VR3008", "scope", "host-case");
  if (/[^\u0000-\u007f]/.test(raw.host)) return reject("VR3008", "scope", "IDN hostname");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return reject("VR3008", "scope", `invalid url ${url}`);
  }
  if (parsed.username || parsed.password) {
    return reject("VR3008", "scope", "url userinfo");
  }
  let normalized: ReturnType<typeof normalizeHttpUrl>;
  try {
    normalized = normalizeHttpUrl(url);
  } catch {
    return reject("VR3008", "scope", "url normalize failed");
  }
  const receiptHost = httpHosts(receipt, keys);
  if (!receiptHost.includes(normalized.host)) {
    return reject("VR3008", "scope", `host ${normalized.host} not in receipt`);
  }
  const receiptScheme = httpScheme(receipt);
  if (receiptScheme === "https" && parsed.protocol === "http:") {
    return reject("VR3008", "scope", "scheme downgrade");
  }

  const httpKeys = keys.filter((k) => k.startsWith("http:"));
  const pathOk = httpKeys.some((k) => {
    const parts = k.split(":");
    const host = parts[1] ?? "";
    const path = parts.slice(2).join(":") || "/";
    if (host !== normalized.host) return false;
    return pathEqualsOrExtends(path, normalized.path);
  });
  if (pathOk) return null;

  const constUrls = Object.values(signature.constants ?? {}).filter((v) => typeof v === "string") as string[];
  const constHit = constUrls.some((c) => {
    try {
      const n = normalizeHttpUrl(c);
      return n.href === normalized.href || (n.host === normalized.host && n.path === normalized.path);
    } catch {
      return c === url;
    }
  });
  if (constHit && (origin === "registered" || origin === "builtin")) return null;

  return reject("VR3008", "scope", `url ${normalized.path} not in resource_keys`);
}

function pathEqualsOrExtends(resourcePath: string, planPath: string): boolean {
  if (resourcePath === planPath) return true;
  const rp = resourcePath.endsWith("/") ? resourcePath.slice(0, -1) : resourcePath;
  const pp = planPath.endsWith("/") ? planPath.slice(0, -1) : planPath;
  if (pp === rp) return true;
  return pp.startsWith(rp + "/");
}

function assertSqlScope(
  step: Extract<CompensationStep, { kind: "sql_statement" }>,
  rec: Record<string, JsonValue>,
  receipt: EffectReceipt,
  keys: string[],
): PlanRejection | null {
  const table = stringify(rec.table).toLowerCase();
  const sqlKeys = keys.filter((k) => k.startsWith("sql:"));
  const tables = sqlKeys.map((k) => k.split(":")[3]?.toLowerCase()).filter(Boolean) as string[];
  const nameTable = receipt.action.name.match(/^sql\.[A-Z]+\.[^.]+\.(.+)$/)?.[1]?.toLowerCase();
  const allowed = new Set([...tables, ...(nameTable ? [nameTable] : [])]);
  if (allowed.size && !allowed.has(table)) {
    return reject("VR3008", "scope", `table ${table} not in receipt`);
  }

  const pkCols = pkColumns(keys, receipt.bindings);
  if (step.statement === "UPDATE" || step.statement === "DELETE") {
    const where = asRecord(rec.where);
    for (const col of pkCols) {
      if (!(col in where)) return reject("VR3008", "scope", `WHERE missing pk ${col}`);
    }
  }

  const observed = observedRowCount(receipt);
  const max = step.expect_rowcount.max;
  if (observed !== undefined && max > observed) {
    return reject("VR3008", "scope", `expect_rowcount.max ${max} > observed ${observed}`);
  }
  return null;
}

function assertFsScope(path: string, receipt: EffectReceipt, keys: string[], _side: "single"): PlanRejection | null {
  const resolved = resolveFsPath(path);
  const lexical = lexicalNormalize(path);
  const fsKeys = keys.filter((k) => k.startsWith("fs:")).map((k) => k.slice(3));
  const captured = typeof receipt.preimage?.meta?.realpath === "string" ? String(receipt.preimage.meta.realpath) : undefined;
  const allowed = new Set([...fsKeys, ...(captured ? [captured] : [])]);
  if (allowed.size > 0 && !allowed.has(resolved) && !allowed.has(path) && !allowed.has(lexical)) {
    return reject("VR3008", "scope", `fs path ${resolved} not in resource_keys`);
  }
  const meta = receipt.preimage?.meta;
  if (meta && existsSync(resolved)) {
    try {
      const st = lstatSync(resolved);
      if (typeof meta.dev === "number" && st.dev !== meta.dev) {
        return reject("VR3008", "scope", "fs (dev,ino) mismatch");
      }
      if (typeof meta.ino === "number" && st.ino !== meta.ino) {
        return reject("VR3008", "scope", "fs (dev,ino) mismatch");
      }
    } catch {
      /* compile-time identity check is best-effort */
    }
  }
  return null;
}

function assertFsRenameScope(from: string, to: string, receipt: EffectReceipt, keys: string[]): PlanRejection | null {
  const a = assertFsScope(from, receipt, keys, "single");
  if (a) return a;
  const fsKeys = keys.filter((k) => k.startsWith("fs:")).map((k) => k.slice(3));
  const resolvedTo = resolveFsPath(to);
  if (fsKeys.length && !fsKeys.includes(resolvedTo) && !fsKeys.includes(to)) {
    const lexical = lexicalNormalize(to);
    if (!fsKeys.includes(lexical)) {
      return reject("VR3008", "scope", `fs rename to ${resolvedTo} not in resource_keys`);
    }
  }
  return null;
}

function assertMcpScope(
  step: Extract<CompensationStep, { kind: "mcp_tool_call" }>,
  rec: Record<string, JsonValue>,
  signature: ActionSignature,
): PlanRejection | null {
  const tool = stringify(rec.tool);
  const permits = signature.permits ?? [];
  if (!permits.includes(tool)) {
    return reject("VR3008", "scope", `mcp tool ${tool} not in permits`);
  }
  const idErr = assertIdShapedReceiptRefs(step.args, "args");
  return idErr;
}

function assertIdShapedReceiptRefs(v: ArgValue, path: string): PlanRejection | null {
  if (isRef(v)) {
    if (isIdPath(path) && !v.$ref.startsWith("receipt.")) {
      return reject("VR3008", "scope", `${path} id-shaped arg must be a receipt.* ref`);
    }
    return null;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const err = assertIdShapedReceiptRefs(v[i] as ArgValue, `${path}[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      const err = assertIdShapedReceiptRefs(val as ArgValue, `${path}.${k}`);
      if (err) return err;
    }
  }
  return null;
}

function isIdPath(path: string): boolean {
  const last = path.split(".").pop() ?? "";
  return /^(id|uuid|ulid|guid|ts|message_id|channel|channel_id|chat_id|user_id|pk)$/i.test(last);
}

function mutatingResourceKeys(
  steps: CompensationStep[],
  resolved: JsonValue[],
  receipt: EffectReceipt,
  signature: ActionSignature,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.kind === "noop" || step.kind === "manual") continue;
    const rec = asRecord(resolved[i]);
    if (step.kind === "http_request") {
      const url = stringify(rec.url);
      try {
        const n = normalizeHttpUrl(url);
        out.push(`http:${n.host}:${n.path}`);
      } catch {
        out.push(`http:unknown:${url}`);
      }
    } else if (step.kind === "sql_statement") {
      const table = stringify(rec.table);
      const dialect = step.dialect;
      const db = receipt.action.target ?? "app";
      out.push(`sql:${dialect}:${db}:${table}`);
    } else if (step.kind === "fs_restore") {
      out.push(`fs:${resolveFsPath(stringify(rec.path))}`);
    } else if (step.kind === "fs_rename") {
      out.push(`fs:${resolveFsPath(stringify(rec.from))}`);
    } else if (step.kind === "mcp_tool_call") {
      const tool = stringify(rec.tool);
      out.push(`mcp:${signature.id}:${tool}`);
    }
  }
  return out;
}

function resolveFsPath(p: string): string {
  const lexical = lexicalNormalize(p);
  try {
    if (existsSync(p)) return realpathSync(p);
  } catch {
    /* fall through */
  }
  try {
    if (existsSync(lexical)) return realpathSync(lexical);
  } catch {
    /* fall through */
  }
  return lexical;
}

function lexicalNormalize(p: string): string {
  const abs = p.startsWith("/");
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (abs ? "/" : "") + out.join("/");
}

function expandHeaderTemplates(steps: CompensationStep[]): CompensationStep[] {
  return steps.map((step) => {
    if (step.kind !== "http_request" || !step.headers) return step;
    const headers: Record<string, ArgValue> = {};
    for (const [k, v] of Object.entries(step.headers)) {
      headers[k] = expandOne(v) as ArgValue;
    }
    return { ...step, headers };
  });
}

function expandOne(v: unknown): unknown {
  if (typeof v === "string") {
    const bearer = v.match(/^(Bearer|Basic|Token)\s+\{\s*\$ref:\s*"([^"]+)"\s*\}$/i);
    if (bearer) return { [bearer[1]!]: { $ref: bearer[2] } };
    const refOnly = v.match(/^\{\s*\$ref:\s*"([^"]+)"\s*\}$/);
    if (refOnly) return { $ref: refOnly[1] };
    return v;
  }
  if (Array.isArray(v)) return v.map(expandOne);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = expandOne(val);
    return out;
  }
  return v;
}

function summarize(steps: CompensationStep[]): string {
  return steps
    .map((s) => {
      switch (s.kind) {
        case "http_request":
          return `${s.method} ${refLabel(s.url)}`;
        case "sql_statement":
          return `${s.statement} ${refLabel(s.table)}`;
        case "fs_restore":
          return `fs_restore ${refLabel(s.path)}`;
        case "fs_rename":
          return `fs_rename ${refLabel(s.from)} -> ${refLabel(s.to)}`;
        case "mcp_tool_call":
          return `mcp ${refLabel(s.tool)}`;
        case "noop":
          return `noop ${s.reason}`;
        case "manual":
          return `manual`;
      }
    })
    .join("; ");
}

function refLabel(v: ArgValue): string {
  if (isRef(v)) return v.$ref;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const rec = v as Record<string, ArgValue>;
    const inner = Object.values(rec)[0];
    if (inner) return refLabel(inner);
  }
  return "?";
}

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, JsonValue>;
  return {};
}

function stringify(v: JsonValue | undefined): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function looksLikeSql(s: string): boolean {
  return /\b(select|insert|update|delete|drop|alter|truncate|union|where)\b/i.test(s) && s.includes(" ");
}

function httpMethodOf(receipt: EffectReceipt): string {
  const rec = asRecord(receipt.args_observed);
  if (typeof rec.method === "string") return rec.method.toUpperCase();
  const m = receipt.action.name.match(/^http\.([A-Z]+)\./);
  return m?.[1] ?? "";
}

function httpHosts(receipt: EffectReceipt, keys: string[]): string[] {
  const hosts = keys.filter((k) => k.startsWith("http:")).map((k) => k.split(":")[1] ?? "");
  const rec = asRecord(receipt.args_observed);
  if (typeof rec.url === "string") {
    try {
      hosts.push(normalizeHttpUrl(rec.url).host);
    } catch {
      /* ignore */
    }
  }
  if (typeof receipt.bindings.resource_url === "string") {
    try {
      hosts.push(normalizeHttpUrl(receipt.bindings.resource_url).host);
    } catch {
      /* ignore */
    }
  }
  return hosts.filter(Boolean);
}

function httpScheme(receipt: EffectReceipt): string {
  const rec = asRecord(receipt.args_observed);
  const url = typeof rec.url === "string" ? rec.url : typeof receipt.bindings.resource_url === "string" ? receipt.bindings.resource_url : "";
  try {
    return new URL(url).protocol.replace(":", "");
  } catch {
    return "https";
  }
}

function pkColumns(keys: string[], bindings: Record<string, JsonValue>): string[] {
  const cols = new Set<string>();
  for (const k of keys) {
    if (!k.startsWith("sql:")) continue;
    const pkPart = k.split(":").slice(4).join(":");
    for (const pair of pkPart.split(",")) {
      const col = pair.split("=")[0];
      if (col) cols.add(col);
    }
  }
  if (cols.size > 0) return [...cols];
  for (const name of Object.keys(bindings)) {
    if (/^(id|pk|uuid|ulid)$/i.test(name) || name.endsWith("_id")) cols.add(name);
  }
  return [...cols];
}

function observedRowCount(receipt: EffectReceipt): number | undefined {
  if (typeof receipt.preimage?.rows === "number") return receipt.preimage.rows;
  const rec = asRecord(receipt.result_observed);
  if (typeof rec.rowcount === "number") return rec.rowcount;
  if (typeof rec.changes === "number") return rec.changes;
  if (typeof rec.rowCount === "number") return rec.rowCount;
  return undefined;
}
