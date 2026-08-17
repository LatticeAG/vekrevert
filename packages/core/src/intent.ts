/** intent_key volatile-field stripping. Reporting only - never imported by plan/execute/lease/idempotency. */

import type { JsonValue } from "./types.ts";

const VOLATILE_NAME =
  /^(id|uuid|ulid|guid|ts|time|timestamp|created_at|updated_at|nonce|request_id|idempotency_key|trace_id|span_id|etag|version)$/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EPOCH_RE = /^\d{10}$|^\d{13}$/;
const HEX64_RE = /^(?:sha256:)?[0-9a-f]{64}$/i;

function valueLooksVolatile(v: JsonValue): boolean {
  if (typeof v === "number") return EPOCH_RE.test(String(Math.trunc(v)));
  if (typeof v !== "string") return false;
  return UUID_RE.test(v) || ULID_RE.test(v) || ISO_RE.test(v) || EPOCH_RE.test(v) || HEX64_RE.test(v);
}

function dropAtPath(value: JsonValue, path: string): JsonValue {
  const p = path.replace(/^\$\.?/, "");
  const parts = p.split(".").filter(Boolean);
  return dropParts(value, parts);
}

function dropParts(value: JsonValue, parts: string[]): JsonValue {
  if (parts.length === 0 || value === null || typeof value !== "object") return value;
  const [head, ...rest] = parts;
  if (Array.isArray(value)) return value;
  if (!(head! in value)) return value;
  if (rest.length === 0) {
    const copy = { ...value };
    delete copy[head!];
    return copy;
  }
  return { ...value, [head!]: dropParts((value as Record<string, JsonValue>)[head!] as JsonValue, rest) };
}

function stripHeuristic(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripHeuristic);
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(value)) {
    if (VOLATILE_NAME.test(k) && valueLooksVolatile(v as JsonValue)) continue;
    out[k] = stripHeuristic(v as JsonValue);
  }
  return out;
}

/** Drop declared JSONPaths first; otherwise structural heuristic (name AND value must match). */
export function stripVolatile(args: JsonValue, declaredPaths?: string[]): JsonValue {
  let cur = args;
  if (declaredPaths && declaredPaths.length > 0) {
    for (const p of declaredPaths) cur = dropAtPath(cur, p);
    return cur;
  }
  return stripHeuristic(args);
}
