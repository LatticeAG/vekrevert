/** Deterministic compensator matching (§6.2). */

import { evalJsonPath } from "./jsonpath.ts";
import { normalizeHttpUrl } from "./resource.ts";
import type {
  ActionRef,
  ActionSignature,
  CompensatorCandidate,
  JsonValue,
  MatchResult,
  Predicate,
  SignatureMatcher,
} from "./types.ts";

export type MatchableCompensator = ActionSignature & { registered_at?: string; disabled?: boolean };

export interface MatchCompensatorResult extends MatchResult {
  predicate_errors: Array<{ id: string; code: "VR3014"; detail: string }>;
}

const SOURCE_RANK: Record<ActionSignature["source"], number> = {
  registered: 0,
  builtin: 1,
  drafted: 2,
};

export function matchCompensator(
  registry: MatchableCompensator[],
  action: ActionRef,
  args: JsonValue,
  result?: JsonValue,
): MatchCompensatorResult {
  const predicate_errors: MatchCompensatorResult["predicate_errors"] = [];
  const scored: Array<{ sig: MatchableCompensator; score: number }> = [];

  for (const sig of registry) {
    if (sig.disabled) continue;
    if (!kindEligible(sig.match, action.kind)) continue;
    if (!kindPredicate(sig.match, action, args, result)) continue;
    const pred = evalAppliesWhen(sig, args, result);
    if (pred.error) {
      predicate_errors.push({ id: sig.id, code: "VR3014", detail: pred.error });
      continue;
    }
    if (!pred.ok) continue;
    scored.push({ sig, score: specificityScore(sig) });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const sr = SOURCE_RANK[a.sig.source] - SOURCE_RANK[b.sig.source];
    if (sr !== 0) return sr;
    const ta = a.sig.registered_at ?? "";
    const tb = b.sig.registered_at ?? "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.sig.id < b.sig.id ? -1 : a.sig.id > b.sig.id ? 1 : 0;
  });

  const candidates: CompensatorCandidate[] = scored.map((s) => ({
    id: s.sig.id,
    score: s.score,
    source: s.sig.source,
  }));

  return {
    matched: scored[0]?.sig ?? null,
    candidates,
    predicate_errors,
  };
}

export function specificityScore(sig: ActionSignature): number {
  const m = sig.match;
  const notStar = m.kind !== "*" ? 1 : 0;
  const literals = literalSegments(m);
  const applies = sig.applies_when?.length ?? 0;
  const version = m.kind === "mcp_tool" && m.version ? 1 : 0;
  const dialect = m.kind === "sql" && m.dialect ? 1 : 0;
  return 1000 * notStar + 100 * literals + 50 * applies + 25 * version + 10 * dialect;
}

function kindEligible(match: SignatureMatcher, actionKind: ActionRef["kind"]): boolean {
  if (match.kind === "*") return true;
  if (match.kind === "mcp_tool") return actionKind === "mcp_tool";
  return match.kind === actionKind;
}

function kindPredicate(
  match: SignatureMatcher,
  action: ActionRef,
  args: JsonValue,
  result?: JsonValue,
): boolean {
  void result;
  const rec = asRecord(args);
  switch (match.kind) {
    case "*":
      return true;
    case "http": {
      const method = (str(rec.method) ?? methodFromName(action.name) ?? "").toUpperCase();
      if (!oneOf(match.method, method)) return false;
      const url = str(rec.url) ?? action.target ?? "";
      if (!url) return false;
      return matchHttpUrl(match.url_pattern, url);
    }
    case "sql": {
      const statement = (str(rec.statement) ?? sqlKindFromName(action.name) ?? "").toUpperCase();
      if (!oneOf(match.statement, statement)) return false;
      const table = foldTable(str(rec.table) ?? tableFromName(action.name) ?? "", match.dialect);
      const want = foldTable(match.table, match.dialect);
      if (want !== "*" && table !== want) return false;
      if (match.dialect) {
        const d = str(rec.dialect) ?? "unknown";
        if (d !== match.dialect) return false;
      }
      return true;
    }
    case "fs": {
      const op = str(rec.op) ?? fsOpFromName(action.name) ?? "";
      if (!oneOf(match.op, op)) return false;
      const real = str(rec.realpath) ?? str(rec.path) ?? action.target ?? "";
      return globMatch(match.path_glob, real);
    }
    case "mcp_tool": {
      const tool = str(rec.tool) ?? mcpToolFromName(action.name) ?? "";
      if (tool !== match.tool) return false;
      if (match.version) {
        const observed = str(rec.version) ?? action.version;
        if (!observed || !versionMatch(match.version, observed)) return false;
      }
      return true;
    }
    case "sdk_fn": {
      const module = str(rec.module) ?? sdkParts(action.name).module;
      const fn = str(rec.fn) ?? sdkParts(action.name).fn;
      return module === match.module && fn === match.fn;
    }
    case "shell": {
      const argv = asStringArray(rec.argv) ?? (str(rec.command) ? [str(rec.command)!] : undefined);
      if (!argv) return false;
      return matchArgv(match.argv_template, argv);
    }
  }
}

function evalAppliesWhen(
  sig: MatchableCompensator,
  args: JsonValue,
  result?: JsonValue,
): { ok: boolean; error?: string } {
  const preds = sig.applies_when;
  if (!preds || preds.length === 0) return { ok: true };
  for (const pred of preds) {
    try {
      if (!evalPredicate(pred, sig, args, result)) return { ok: false };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true };
}

function evalPredicate(
  pred: Predicate,
  sig: MatchableCompensator,
  args: JsonValue,
  result?: JsonValue,
): boolean {
  if ("result_status_in" in pred) {
    const status = resultStatus(result);
    if (status === undefined) return false;
    return pred.result_status_in.includes(status);
  }
  if ("arg_equals" in pred) {
    const got = evalJsonPath(args, pred.arg_equals.path);
    return jsonEq(got, pred.arg_equals.value);
  }
  if ("header_present" in pred) {
    const headers = {
      ...asStringMap(asRecord(args).headers),
      ...asStringMap(asRecord(result).headers),
    };
    const want = pred.header_present.toLowerCase();
    return Object.keys(headers).some((k) => k.toLowerCase() === want);
  }
  if ("delete_undoes_create" in pred) {
    return (sig.delete_undoes_create ?? false) === pred.delete_undoes_create;
  }
  if ("cascades" in pred) {
    return true;
  }
  throw new Error("unknown predicate");
}

export function matchHttpUrl(pattern: string, observed: string): boolean {
  if (pattern === "*" || pattern === "**" || pattern === "*://*/**") return true;
  let obs: ReturnType<typeof normalizeHttpUrl>;
  try {
    obs = normalizeHttpUrl(observed);
  } catch {
    return false;
  }
  const pat = splitUrlPattern(pattern);
  if (!pat) return false;
  if (pat.scheme && pat.scheme !== "*" && pat.scheme !== new URL(obs.href).protocol.replace(":", "")) return false;
  if (pat.host && !isWildcardHost(pat.host) && pat.host !== obs.host) return false;
  return matchPathPattern(pat.segments, obs.path);
}

function isWildcardHost(host: string): boolean {
  return host === "*" || host === "**" || /^\{[^}]+\}$/.test(host);
}

function oneOf(want: string | string[], got: string): boolean {
  return Array.isArray(want) ? want.includes(got) : want === got;
}

function splitUrlPattern(pattern: string): { scheme: string; host: string; segments: string[] } | null {
  const m = pattern.trim().match(/^(https?|\*):\/\/([^/?#]+)([^?#]*)?/i);
  if (!m) return null;
  let host = (m[2] ?? "").toLowerCase();
  if (host.endsWith(":443") && m[1]!.toLowerCase() === "https") host = host.slice(0, -4);
  if (host.endsWith(":80") && m[1]!.toLowerCase() === "http") host = host.slice(0, -3);
  const path = m[3] && m[3].length > 0 ? m[3] : "/";
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  const segments: string[] = [];
  for (const p of parts) {
    if (p === "..") segments.pop();
    else segments.push(p);
  }
  return { scheme: m[1]!.toLowerCase(), host, segments };
}

function matchPathPattern(patternSegs: string[], observedPath: string): boolean {
  const obs = observedPath.split("/").filter((p) => p !== "");
  let pi = 0;
  let oi = 0;
  while (pi < patternSegs.length) {
    const seg = patternSegs[pi]!;
    if (seg === "**") {
      if (pi !== patternSegs.length - 1) return false;
      return true;
    }
    if (oi >= obs.length) return false;
    const got = obs[oi]!;
    if (seg === "{param}" || /^\{[^}]+\}$/.test(seg)) {
      if (!got) return false;
    } else if (seg !== got) {
      return false;
    }
    pi++;
    oi++;
  }
  return oi === obs.length;
}

function globMatch(glob: string, path: string): boolean {
  if (glob === "**" || glob === "**/**") return true;
  const re = globToRegExp(glob);
  return re.test(path);
}

function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
      continue;
    }
    if (c === "*") {
      out += "[^/]*";
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      continue;
    }
    if ("\\^$+{}[]()|.".includes(c)) out += `\\${c}`;
    else out += c;
  }
  out += "$";
  return new RegExp(out);
}

function matchArgv(template: string[], argv: string[]): boolean {
  if (template.length !== argv.length) return false;
  for (let i = 0; i < template.length; i++) {
    const t = template[i]!;
    if (t === "{}") continue;
    if (t !== argv[i]) return false;
  }
  return true;
}

function versionMatch(pattern: string, observed: string): boolean {
  if (pattern === observed) return true;
  const stripped = pattern.replace(/^[\^~>=<\s]+/, "").replace(/\.x$|\.\*$/, "");
  if (observed === stripped) return true;
  if (observed.startsWith(stripped)) return true;
  if (stripped.startsWith(observed)) return true;
  const major = stripped.split(".")[0] ?? "";
  if (major && observed.split(".")[0] === major && /[\^~>=*]/.test(pattern)) return true;
  return false;
}

function literalSegments(match: SignatureMatcher): number {
  switch (match.kind) {
    case "http": {
      const split = splitUrlPattern(match.url_pattern);
      if (!split) return 0;
      return split.segments.filter((s) => s !== "**" && !/^\{[^}]+\}$/.test(s)).length;
    }
    case "shell":
      return match.argv_template.filter((s) => s !== "{}").length;
    case "fs":
      return match.path_glob.split("/").filter((s) => s && s !== "*" && s !== "**" && s !== "?" && !s.includes("*")).length;
    case "sdk_fn":
      return 2;
    case "mcp_tool":
      return 1;
    case "sql":
      return match.table === "*" ? 0 : 1;
    case "*":
      return 0;
  }
}

function foldTable(table: string, dialect?: string): string {
  let t = table.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("`") && t.endsWith("`")) || (t.startsWith("[") && t.endsWith("]"))) {
    t = t.slice(1, -1);
  }
  if (t.includes(".")) {
    const parts = t.split(".");
    t = parts[parts.length - 1] ?? t;
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("`") && t.endsWith("`"))) t = t.slice(1, -1);
  }
  void dialect;
  return t.toLowerCase();
}

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, JsonValue>;
  return {};
}

function str(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  if (!v.every((x) => typeof x === "string")) return undefined;
  return v as string[];
}

function asStringMap(v: JsonValue | undefined): Record<string, string> {
  const rec = asRecord(v);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(rec)) if (typeof val === "string") out[k] = val;
  return out;
}

function resultStatus(result: JsonValue | undefined): number | undefined {
  if (typeof result === "number") return result;
  const rec = asRecord(result);
  const s = rec.status ?? rec.statusCode;
  return typeof s === "number" ? s : undefined;
}

function jsonEq(a: JsonValue | undefined, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function methodFromName(name: string): string | undefined {
  const m = name.match(/^http\.([A-Z]+)\./);
  return m?.[1];
}

function sqlKindFromName(name: string): string | undefined {
  const m = name.match(/^sql\.([A-Z]+)\./);
  return m?.[1];
}

function tableFromName(name: string): string | undefined {
  const m = name.match(/^sql\.[A-Z]+\.[^.]+\.(.+)$/);
  return m?.[1];
}

function fsOpFromName(name: string): string | undefined {
  const m = name.match(/^fs\.([^.]+)\./);
  return m?.[1];
}

function mcpToolFromName(name: string): string | undefined {
  const m = name.match(/^mcp\.[^.]+\.(.+)$/);
  return m?.[1];
}

function sdkParts(name: string): { module: string; fn: string } {
  const rest = name.replace(/^sdk\./, "");
  const i = rest.lastIndexOf(".");
  if (i < 0) return { module: rest, fn: "" };
  return { module: rest.slice(0, i), fn: rest.slice(i + 1) };
}
