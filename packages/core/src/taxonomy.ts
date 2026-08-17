/** Rule-based hot-path classification (D1). Model is off-path and escalate-only. */

import type {
  ActionRef,
  ActionSignature,
  CaptureFidelity,
  ClassificationRecord,
  ClassificationSource,
  CompensatorCandidate,
  JsonValue,
  PreimageRef,
  Tier,
  TierEvidence,
} from "./types.ts";
import { classifySql } from "./sqlkind.ts";

export const TIER_ORDER: Record<Tier, number> = { T1: 1, T2: 2, T3: 3, T4: 4 };

export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

export function minTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER[a] <= TIER_ORDER[b] ? a : b;
}

export interface ClassifyContext {
  result?: JsonValue;
  resultStatus?: number;
  resultHeaders?: Record<string, string>;
  preimage?: PreimageRef;
  compensatorMatched?: boolean;
  manifest?: ActionSignature;
  writableRoots?: string[];
  internalHosts?: string[];
  transportError?: boolean;
  timeout?: boolean;
  recreateFromPreimage?: boolean;
  pkResolvable?: boolean;
  affectedRows?: number;
  maxPreimageBytes?: number;
  maxPreimageRows?: number;
  networkOrFuseMount?: boolean;
  realpathEscapes?: boolean;
  candidates?: CompensatorCandidate[];
  modelTier?: Tier;
  scopeViolation?: boolean;
  /** When set, tiers that need a capability this path lacks become T4 (D5). */
  captureFidelity?: CaptureFidelity;
}

const READ_HTTP = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
const SEARCH_SEGMENTS = new Set(["search", "query", "graphql", "batch", "rpc"]);
const READ_FS = new Set(["open", "stat", "readdir", "readlink"]);
const MESSAGE_TOOLS: Record<string, { tier: Tier; leak: string }> = {
  "chat.postMessage": { tier: "T3", leak: "observers" },
  "slack.chat.postMessage": { tier: "T3", leak: "observers" },
  "discord.createMessage": { tier: "T3", leak: "observers" },
  "telegram.sendMessage": { tier: "T3", leak: "observers" },
};

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, JsonValue>;
  return {};
}

function str(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return undefined;
}

function lastSegment(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return (parts[parts.length - 1] ?? "").toLowerCase();
  } catch {
    const parts = url.split("?")[0]!.split("/").filter(Boolean);
    return (parts[parts.length - 1] ?? "").toLowerCase();
  }
}

function hasBody(args: Record<string, JsonValue>): boolean {
  const body = args.body;
  if (body === undefined || body === null) return false;
  if (typeof body === "string") return body.length > 0;
  if (typeof body === "object") return Array.isArray(body) ? body.length > 0 : Object.keys(body).length > 0;
  return true;
}

function bodyId(result: JsonValue | undefined): boolean {
  const r = asRecord(result);
  return typeof r.id === "string" || typeof r.id === "number";
}

function isPrivateHost(host: string, extra: string[] = []): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (extra.some((x) => x.toLowerCase() === h)) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "127.0.0.1" || h.startsWith("127.")) return true;
  if (h === "::1") return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (h.startsWith("fd") || h.startsWith("fe80:")) return true;
  return false;
}

export function classifyLocality(
  target: string | undefined,
  internalHosts: string[] = [],
): { locality: ActionRef["locality"]; tier: Tier; reasons: string[] } {
  if (!target) return { locality: "unknown", tier: "T3", reasons: ["locality_unknown_treated_external"] };
  let host = target;
  try {
    if (target.includes("://")) host = new URL(target).hostname;
  } catch {
    host = target;
  }
  if (isPrivateHost(host, internalHosts)) {
    return { locality: "internal", tier: "T1", reasons: ["locality_internal"] };
  }
  return { locality: "external", tier: "T1", reasons: ["locality_external"] };
}

function httpMethod(action: ActionRef, args: Record<string, JsonValue>): string {
  const m = str(args.method) ?? action.name.split(".")[1] ?? "";
  return m.toUpperCase();
}

function httpUrl(action: ActionRef, args: Record<string, JsonValue>): string {
  return str(args.url) ?? action.target ?? action.name.replace(/^http\.[A-Z]+\./, "https://");
}

export function classifyStructural(
  action: ActionRef,
  args: JsonValue,
  ctx: ClassifyContext = {},
): { tier: Tier; reasons: string[]; in_doubt: boolean; locality: ActionRef["locality"] } {
  const rec = asRecord(args);
  const loc = classifyLocality(action.target ?? str(rec.url) ?? str(rec.path), ctx.internalHosts);
  const reasons: string[] = [];
  let in_doubt = false;
  let tier: Tier = "T4";

  if (action.kind === "shell") {
    reasons.push("shell_unclassifiable");
    return { tier: "T4", reasons, in_doubt: false, locality: loc.locality };
  }

  if (action.kind === "http") {
    const method = httpMethod(action, rec);
    const url = httpUrl(action, rec);
    const override = header(asRecord(rec.headers) as unknown as Record<string, string>, "x-http-method-override")
      ?? header(ctx.resultHeaders, "x-http-method-override");
    const headersObj = asRecord(rec.headers) as unknown as Record<string, string>;
    const ov = header(headersObj, "X-HTTP-Method-Override");
    if (ov || override) {
      tier = "T3";
      reasons.push("method_override");
    } else if (READ_HTTP.has(method) && !hasBody(rec)) {
      tier = "T1";
      reasons.push("http_safe_method");
      if (header(ctx.resultHeaders, "set-cookie")) {
        tier = "T2";
        reasons.push("set_cookie");
      }
    } else if (READ_HTTP.has(method) && hasBody(rec)) {
      tier = "T3";
      reasons.push("get_with_body");
    } else if (method === "POST" && SEARCH_SEGMENTS.has(lastSegment(url))) {
      tier = "T3";
      reasons.push("post_search_like");
    } else if (method === "DELETE") {
      if (ctx.recreateFromPreimage && ctx.preimage && !ctx.preimage.truncated) {
        tier = "T3";
        reasons.push("delete_with_preimage");
      } else {
        tier = "T4";
        reasons.push("delete_without_preimage");
      }
    } else if (method === "PUT" || method === "PATCH") {
      if (ctx.resultStatus === 201 && (header(ctx.resultHeaders, "location") || bodyId(ctx.result))) {
        tier = "T3";
        reasons.push("http_create");
      } else if (ctx.preimage && !ctx.preimage.truncated) {
        tier = loc.locality === "internal" ? "T2" : "T3";
        reasons.push("http_update_with_preimage");
      } else {
        tier = "T4";
        reasons.push("http_update_without_preimage");
      }
    } else if (method === "POST" || method === "PUT") {
      if (ctx.resultStatus !== undefined && ctx.resultStatus >= 400 && !header(ctx.resultHeaders, "location") && !bodyId(ctx.result)) {
        tier = "T1";
        reasons.push("nothing_landed");
      } else if (ctx.resultStatus === 201 || header(ctx.resultHeaders, "location") || bodyId(ctx.result)) {
        tier = "T3";
        reasons.push("http_create");
      } else {
        tier = "T3";
        reasons.push("http_mutation");
      }
    } else {
      tier = "T3";
      reasons.push("http_mutation");
    }

    if ((ctx.transportError || ctx.timeout || (ctx.resultStatus !== undefined && ctx.resultStatus >= 500)) && !READ_HTTP.has(method)) {
      in_doubt = true;
      reasons.push("http_in_doubt");
      if (tier === "T1") {
        tier = method === "DELETE" ? "T4" : "T3";
      }
    }
    if (ctx.resultStatus !== undefined && ctx.resultStatus >= 400 && ctx.resultStatus < 500 && !header(ctx.resultHeaders, "location") && !bodyId(ctx.result)) {
      if (!in_doubt) {
        tier = "T1";
        reasons.push("client_error_nothing_landed");
      }
    }
    if (action.locality === "internal" || loc.locality === "internal") {
      if (tier === "T1" && !(READ_HTTP.has(method) && !hasBody(rec))) {
        tier = "T2";
        reasons.push("internal_write_floor");
      }
    }
    return { tier, reasons, in_doubt, locality: loc.locality };
  }

  if (action.kind === "sql") {
    const sql = str(rec.sql) ?? str(rec.statement) ?? "";
    const parsed = classifySql(sql);
    if (parsed.multiStatement) {
      return { tier: "T4", reasons: ["sql_multi_statement"], in_doubt: false, locality: loc.locality };
    }
    if (parsed.kind === "SELECT" && !parsed.forUpdate && !parsed.modifyingCte) {
      return { tier: "T1", reasons: ["sql_select"], in_doubt: false, locality: loc.locality };
    }
    if (parsed.kind === "SELECT" && parsed.forUpdate) {
      return { tier: "T2", reasons: ["sql_select_for_update"], in_doubt: false, locality: loc.locality };
    }
    const internal = (action.locality ?? loc.locality) === "internal";
    const t23 = (): Tier => (internal ? "T2" : "T3");
    if (parsed.kind === "INSERT") {
      if (ctx.pkResolvable === false) return { tier: "T4", reasons: ["insert_no_pk"], in_doubt: false, locality: loc.locality };
      if (ctx.pkResolvable === true || parsed.returning) return { tier: t23(), reasons: ["insert_pk"], in_doubt: false, locality: loc.locality };
      return { tier: "T4", reasons: ["insert_no_pk"], in_doubt: false, locality: loc.locality };
    }
    if (parsed.kind === "UPDATE") {
      const over = (ctx.affectedRows ?? 0) > (ctx.maxPreimageRows ?? 10_000);
      if (!ctx.preimage || ctx.preimage.truncated || over) {
        return { tier: "T4", reasons: ["update_no_preimage"], in_doubt: false, locality: loc.locality };
      }
      return { tier: t23(), reasons: ["update_preimage"], in_doubt: false, locality: loc.locality };
    }
    if (parsed.kind === "DELETE") {
      if (!ctx.preimage || ctx.preimage.truncated) {
        return { tier: "T4", reasons: ["delete_no_row_images"], in_doubt: false, locality: loc.locality };
      }
      return { tier: t23(), reasons: ["delete_row_images"], in_doubt: false, locality: loc.locality };
    }
    if (["TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT", "REINDEX", "VACUUM"].includes(parsed.kind)) {
      return { tier: "T4", reasons: ["sql_ddl"], in_doubt: false, locality: loc.locality };
    }
    if (parsed.kind === "CALL" || parsed.kind === "EXEC") {
      return { tier: "T4", reasons: ["sql_call"], in_doubt: false, locality: loc.locality };
    }
    return { tier: "T4", reasons: ["sql_unknown"], in_doubt: false, locality: loc.locality };
  }

  if (action.kind === "fs") {
    const op = (str(rec.op) ?? action.name.split(".")[1] ?? "").toLowerCase();
    const path = str(rec.path) ?? str(rec.realpath) ?? action.target ?? "";
    const roots = ctx.writableRoots ?? [];
    if (ctx.realpathEscapes || ctx.networkOrFuseMount) {
      return { tier: "T4", reasons: ["fs_escape_or_remote"], in_doubt: false, locality: "internal" };
    }
    if (roots.length > 0) {
      const real = str(rec.realpath) ?? path;
      const ok = roots.some((r) => real === r || real.startsWith(r.endsWith("/") ? r : r + "/"));
      if (!ok) return { tier: "T4", reasons: ["scope_violation"], in_doubt: false, locality: "internal" };
    }
    if (READ_FS.has(op) || op === "open_rdonly") {
      return { tier: "T1", reasons: ["fs_read"], in_doubt: false, locality: "internal" };
    }
    if (op === "write" || op === "truncate") {
      if (ctx.preimage?.truncated) return { tier: "T4", reasons: ["preimage_truncated"], in_doubt: false, locality: "internal" };
      if (ctx.preimage?.kind === "fs_absent") return { tier: "T2", reasons: ["fs_create"], in_doubt: false, locality: "internal" };
      if (ctx.preimage?.kind === "fs_bytes") return { tier: "T2", reasons: ["fs_overwrite"], in_doubt: false, locality: "internal" };
      if (ctx.preimage === undefined) {
        const fid = ctx.captureFidelity;
        if (fid && fid !== "full") {
          return { tier: "T4", reasons: ["fidelity_downgrade_no_preimage"], in_doubt: false, locality: "internal" };
        }
        return { tier: "T2", reasons: ["fs_write_assume_capture"], in_doubt: false, locality: "internal" };
      }
      return { tier: "T2", reasons: ["fs_write"], in_doubt: false, locality: "internal" };
    }
    if (op === "mkdir" || op === "rename" || op === "chmod" || op === "chown" || op === "utimes") {
      return { tier: "T2", reasons: [`fs_${op}`], in_doubt: false, locality: "internal" };
    }
    if (op === "unlink") {
      if (ctx.preimage && !ctx.preimage.truncated) return { tier: "T2", reasons: ["fs_unlink_preimage"], in_doubt: false, locality: "internal" };
      return { tier: "T4", reasons: ["fs_unlink_no_preimage"], in_doubt: false, locality: "internal" };
    }
    return { tier: "T4", reasons: ["fs_unknown"], in_doubt: false, locality: "internal" };
  }

  if (action.kind === "mcp_tool" || action.kind === "sdk_fn") {
    const tool = str(rec.tool) ?? action.name.split(".").slice(-1)[0] ?? action.name;
    const email = /smtp|resend|ses|postmark|email|sendmail/i.test(action.name + tool);
    const sms = /sms|push_notification|notify\.push/i.test(action.name + tool);
    if (email || sms) return { tier: "T4", reasons: ["message_irreversible"], in_doubt: false, locality: loc.locality };
    for (const [k, v] of Object.entries(MESSAGE_TOOLS)) {
      if (tool === k || action.name.endsWith(k) || action.name.includes(k)) {
        return { tier: v.tier, reasons: ["message_retractable"], in_doubt: false, locality: loc.locality };
      }
    }
    return { tier: "T4", reasons: ["mcp_unknown"], in_doubt: false, locality: loc.locality };
  }

  reasons.push("unknown_action_kind");
  return { tier: "T4", reasons, in_doubt: false, locality: loc.locality };
}

export function joinTier(s: TierEvidence): { tier: Tier; reason: string[] } {
  let tier = maxTier(s.structural, s.locality);
  if (s.manifest && !s.scopeViolation) tier = s.manifest.tier;
  if (s.scopeViolation) tier = "T4";
  if (s.model) tier = maxTier(tier, s.model.tier);
  const reason = [...s.reasons];
  if (!s.compensatorMatched && tier === "T3") {
    return { tier, reason: [...reason, "compensator_unavailable"] };
  }
  return { tier, reason };
}

export function detectScopeViolation(
  action: ActionRef,
  args: JsonValue,
  manifest?: ActionSignature,
  writableRoots?: string[],
): boolean {
  if (action.kind === "fs") {
    const path = str(asRecord(args).path) ?? action.target ?? "";
    if (writableRoots && writableRoots.length > 0) {
      const ok = writableRoots.some((r) => path === r || path.startsWith(r.endsWith("/") ? r : r + "/"));
      if (!ok) return true;
    }
    if (manifest?.match.kind === "fs" && manifest.match.path_glob) {
      const glob = manifest.match.path_glob;
      if (glob.includes("**")) {
        const prefix = glob.split("**")[0] ?? "";
        if (prefix && !path.startsWith(prefix.replace(/\/$/, ""))) return true;
      }
    }
  }
  return false;
}

export function classifyAction(
  action: ActionRef,
  args: JsonValue,
  ctx: ClassifyContext = {},
): ClassificationRecord {
  const structural = classifyStructural(action, args, ctx);
  const loc = classifyLocality(action.target ?? str(asRecord(args).url), ctx.internalHosts);
  const scopeViolation =
    ctx.scopeViolation ?? detectScopeViolation(action, args, ctx.manifest, ctx.writableRoots);
  const locTier: Tier =
    loc.locality === "internal" && structural.tier === "T1" ? "T1" : loc.locality === "internal" ? "T2" : "T1";
  const evidence: TierEvidence = {
    structural: structural.tier,
    locality: locTier,
    manifest: ctx.manifest ? { tier: ctx.manifest.tier } : undefined,
    model: ctx.modelTier ? { tier: ctx.modelTier } : undefined,
    scopeViolation,
    compensatorMatched: ctx.compensatorMatched ?? false,
    reasons: [...structural.reasons, ...loc.reasons],
  };
  const joined = joinTier(evidence);
  const sources: ClassificationSource[] = [
    { source: "structural", tier: structural.tier, reasons: structural.reasons },
    { source: "locality", tier: locTier, reasons: loc.reasons },
  ];
  if (ctx.manifest) sources.push({ source: "manifest", tier: ctx.manifest.tier, reasons: ["manifest"] });
  if (ctx.modelTier) sources.push({ source: "model", tier: ctx.modelTier, reasons: ["model"] });
  let tier = joined.tier;
  const reasons = [...joined.reason];
  if (
    ctx.captureFidelity &&
    ctx.captureFidelity !== "full" &&
    structural.reasons.includes("fidelity_downgrade_no_preimage")
  ) {
    tier = "T4";
    if (!reasons.includes("fidelity_downgrade_no_preimage")) reasons.push("fidelity_downgrade_no_preimage");
  }
  return {
    tier,
    sources,
    reasons,
    candidates: ctx.candidates ?? [],
    scope_violation: scopeViolation,
  };
}
