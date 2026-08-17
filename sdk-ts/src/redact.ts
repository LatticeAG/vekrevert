/** Redact credentials from observed args. args_hash is over PRE-redaction JCS. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { canonicalize, hashJcs, type JsonValue } from "@latticeag/vekrevert-core";

export const DEFAULT_REDACT_PATHS = ["$.password", "$.token", "$.authorization", "$.ssn"] as const;
export const DEFAULT_REDACT_PATTERNS = ["sk_live_[A-Za-z0-9]+"] as const;
export const DEFAULT_COMMIT_KEY_PATH = ".vekrevert/keys/commit.key";

const SENSITIVE_KEYS = new Set(["password", "token", "authorization", "ssn"]);

export interface RedactOptions {
  paths?: string[];
  patterns?: string[];
  commitKeyPath?: string;
  salt?: Uint8Array;
}

export interface RedactResult {
  args_hash: string;
  args_observed: JsonValue;
  args_commitments: Record<string, string>;
  redactions: string[];
}

export function loadCommitSalt(path: string = DEFAULT_COMMIT_KEY_PATH): Uint8Array {
  if (existsSync(path)) return new Uint8Array(readFileSync(path));
  mkdirSync(dirname(path), { recursive: true });
  const salt = randomBytes(32);
  writeFileSync(path, salt);
  chmodSync(path, 0o600);
  return new Uint8Array(salt);
}

export function commitmentFor(salt: Uint8Array, value: JsonValue): string {
  const digest = createHash("sha256")
    .update(salt)
    .update(canonicalize(value))
    .digest("hex");
  return `sha256:${digest}`;
}

function pathMatches(jsonPath: string, configured: string[]): boolean {
  for (const raw of configured) {
    const want = raw.startsWith("$") ? raw : `$.${raw}`;
    if (jsonPath === want) return true;
    if (want.startsWith("$.") && jsonPath.endsWith(want.slice(1))) return true;
  }
  return false;
}

function redactString(s: string, patterns: RegExp[]): { value: string; hit: boolean } {
  let value = s;
  let hit = false;
  for (const re of patterns) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    const global = new RegExp(re.source, flags);
    if (global.test(value)) {
      hit = true;
      value = value.replace(new RegExp(re.source, flags), "[REDACTED]");
    }
  }
  return { value, hit };
}

function walk(
  value: JsonValue,
  jsonPath: string,
  key: string | undefined,
  cfg: { paths: string[]; patterns: RegExp[]; saltOf: () => Uint8Array },
  commitments: Record<string, string>,
  redactions: string[],
): JsonValue {
  if (typeof value === "string") {
    const { value: next, hit } = redactString(value, cfg.patterns);
    if (hit) {
      commitments[jsonPath] = commitmentFor(cfg.saltOf(), value);
      redactions.push(jsonPath);
      return next;
    }
  }

  const byPath = pathMatches(jsonPath, cfg.paths);
  const byKey = key != null && SENSITIVE_KEYS.has(key.toLowerCase());
  if (byPath || byKey) {
    commitments[jsonPath] = commitmentFor(cfg.saltOf(), value);
    redactions.push(jsonPath);
    return { $redacted: true };
  }

  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v, i) =>
      walk(v as JsonValue, `${jsonPath}[${i}]`, undefined, cfg, commitments, redactions),
    );
  }
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = walk(v as JsonValue, `${jsonPath}.${k}`, k, cfg, commitments, redactions);
  }
  return out;
}

/** Hash original args, store redacted form, commit to redacted values with a local salt. */
export function redactArgs(args: JsonValue, opts: RedactOptions = {}): RedactResult {
  const args_hash = hashJcs(args);
  const paths = opts.paths ?? [...DEFAULT_REDACT_PATHS];
  const patternSrc = opts.patterns ?? [...DEFAULT_REDACT_PATTERNS];
  const patterns = patternSrc.map((p) => new RegExp(p));
  let salt = opts.salt;
  const saltOf = (): Uint8Array => {
    if (!salt) salt = loadCommitSalt(opts.commitKeyPath ?? DEFAULT_COMMIT_KEY_PATH);
    return salt;
  };
  const args_commitments: Record<string, string> = {};
  const redactions: string[] = [];
  const args_observed = walk(args, "$", undefined, { paths, patterns, saltOf }, args_commitments, redactions);
  return {
    args_hash,
    args_observed,
    args_commitments: Object.keys(args_commitments).length ? args_commitments : {},
    redactions,
  };
}
