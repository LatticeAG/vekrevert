/** RFC 8785 JSON Canonicalization Scheme. Used by every VekRevert hash. */
import { createHash } from "node:crypto";
import type { JsonValue } from "./types.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function canonicalize(value: JsonValue): string {
  return emit(value);
}

function emit(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("JCS rejects non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return jsonString(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => emit(v)).join(",")}]`;
  }
  const keys = Object.keys(value).sort(utf16Compare);
  const parts: string[] = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue;
    parts.push(`${jsonString(k)}:${emit(v as JsonValue)}`);
  }
  return `{${parts.join(",")}}`;
}

function utf16Compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function jsonString(s: string): string {
  let out = "\"";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += "\\\"";
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += s[i];
  }
  out += "\"";
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Prefixed(data: string | Uint8Array): string {
  return `sha256:${sha256Hex(data)}`;
}

export function hashJcs(value: JsonValue): string {
  return sha256Prefixed(canonicalize(value));
}

export function crockford32(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
      acc &= (1 << bits) - 1;
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(acc << (5 - bits)) & 31];
  }
  return out;
}

export function crockford32OfSha256(input: string | Uint8Array): string {
  const digest = createHash("sha256").update(input).digest();
  return crockford32(digest);
}

const SELF_TESTS: Array<{ input: JsonValue; expected: string }> = [
  { input: { b: 2, a: 1 }, expected: '{"a":1,"b":2}' },
  { input: [1, { z: 1, a: 0 }, null], expected: '[1,{"a":0,"z":1},null]' },
  { input: { "": 0, "\u20ac": "Euro" }, expected: '{"":0,"\u20ac":"Euro"}' },
  { input: true, expected: "true" },
  { input: false, expected: "false" },
  { input: null, expected: "null" },
  { input: 0, expected: "0" },
  { input: 1.5, expected: "1.5" },
  { input: "quote\"slash\\", expected: '"quote\\"slash\\\\"' },
];

export function selfTest(): { ok: true } | { ok: false; failed: string[] } {
  const failed: string[] = [];
  for (const t of SELF_TESTS) {
    const got = canonicalize(t.input);
    if (got !== t.expected) {
      failed.push(`input=${JSON.stringify(t.input)} got=${got} expected=${t.expected}`);
    }
  }
  return failed.length === 0 ? { ok: true } : { ok: false, failed };
}

function runCliSelfTest(): void {
  const result = selfTest();
  if (result.ok) {
    process.stdout.write("jcs self-test: ok\n");
    process.exit(0);
  }
  process.stderr.write(`jcs self-test: fail\n${result.failed.join("\n")}\n`);
  process.exit(1);
}

const entry = process.argv[1] ?? "";
if (process.argv.includes("--self-test") && /jcs\.ts$/.test(entry)) {
  runCliSelfTest();
}
