/** In-doubt resolution (D10). Never assume landed or not_landed. */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { VekRevertError, type EffectReceipt, type JsonValue } from "@latticeag/vekrevert-core";

export type ProbeResult = "landed" | "not_landed" | "unknown";

export interface ProbeOpts {
  backoffMs?: [number, number, number];
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  db?: {
    prepare: (sql: string) => {
      get?: (...params: never[]) => unknown;
      run?: (...params: never[]) => { changes?: number | bigint };
    };
  };
  probe?: (receipt: EffectReceipt) => Promise<ProbeResult> | ProbeResult;
  attempts?: number;
}

const DEFAULT_BACKOFF: [number, number, number] = [1000, 4000, 16000];

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, JsonValue>;
  return {};
}

function str(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" ? v : v == null ? undefined : String(v);
}

async function probeHttp(receipt: EffectReceipt, fetchFn: typeof fetch): Promise<ProbeResult> {
  const url =
    str(receipt.bindings.resource_url) ??
    str(asRecord(receipt.result_observed).url) ??
    str(asRecord(receipt.args_observed).url);
  if (!url) return "unknown";
  try {
    const res = await fetchFn(url, { method: "GET" });
    if (res.status === 404) return "not_landed";
    if (res.status >= 200 && res.status < 400) return "landed";
    if (res.status >= 500) return "unknown";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `"id"`;
  return `"${name}"`;
}

async function probeSql(receipt: EffectReceipt, db: NonNullable<ProbeOpts["db"]>): Promise<ProbeResult> {
  const table = str(receipt.bindings.table) ?? str(asRecord(receipt.args_observed).table);
  if (!table || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return "unknown";
  const pk = receipt.bindings.pk ?? receipt.bindings.id ?? asRecord(receipt.result_observed).id;
  if (pk == null) return "unknown";
  let col = "id";
  for (const k of receipt.resource_keys ?? []) {
    if (!k.startsWith("sql:")) continue;
    const pkPart = k.split(":").slice(4).join(":");
    const c = pkPart.split(",")[0]?.split("=")[0];
    if (c) col = c;
  }
  try {
    const stmt = db.prepare(`SELECT 1 AS n FROM ${quoteIdent(table)} WHERE ${quoteIdent(col)} = ?`);
    const get = stmt.get;
    if (!get) return "unknown";
    const row = get(pk as never);
    return row ? "landed" : "not_landed";
  } catch {
    return "unknown";
  }
}

function num(v: string | number | undefined): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function probeFs(receipt: EffectReceipt): ProbeResult {
  const path =
    str(receipt.bindings.path) ??
    str(asRecord(receipt.args_observed).path) ??
    str(asRecord(receipt.args_observed).realpath) ??
    receipt.action.target;
  if (!path) return "unknown";
  const meta = receipt.preimage?.meta;
  if (!existsSync(path)) {
    if (receipt.preimage?.kind === "fs_absent") return "not_landed";
    if (meta && receipt.preimage?.kind === "fs_bytes") return "not_landed";
    return "not_landed";
  }
  try {
    const st = lstatSync(path);
    if (!meta) return "landed";
    const bytes = st.isFile() ? readFileSync(path) : undefined;
    const hash = bytes ? sha256(bytes) : undefined;
    const sameDev = num(meta.dev) == null || Number(st.dev) === num(meta.dev);
    const sameIno = num(meta.ino) == null || Number(st.ino) === num(meta.ino);
    const mtimeNs = (st as { mtimeNs?: bigint }).mtimeNs;
    const wantMtime = meta.mtime_ns;
    const sameMtime =
      wantMtime == null ||
      (mtimeNs != null && String(mtimeNs) === String(wantMtime)) ||
      (typeof wantMtime === "number" && Math.abs(st.mtimeMs * 1e6 - wantMtime) < 1);
    const sameHash = typeof meta.sha256 !== "string" || meta.sha256 === hash;
    if (sameDev && sameIno && sameMtime && sameHash) return "not_landed";
    return "landed";
  } catch {
    return "unknown";
  }
}

export async function probeOnce(receipt: EffectReceipt, opts: ProbeOpts = {}): Promise<ProbeResult> {
  if (opts.probe) return await opts.probe(receipt);
  if (receipt.action.kind === "http") return probeHttp(receipt, opts.fetch ?? fetch);
  if (receipt.action.kind === "sql") {
    if (!opts.db) return "unknown";
    return probeSql(receipt, opts.db);
  }
  if (receipt.action.kind === "fs") return probeFs(receipt);
  return "unknown";
}

export async function probeEffect(receipt: EffectReceipt, opts: ProbeOpts = {}): Promise<ProbeResult> {
  const attempts = opts.attempts ?? 3;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
  const sleep = opts.sleep ?? sleepDefault;
  let last: ProbeResult = "unknown";
  for (let i = 0; i < attempts; i++) {
    last = await probeOnce(receipt, opts);
    if (last !== "unknown") return last;
    if (i < attempts - 1) await sleep(backoff[i] ?? backoff[backoff.length - 1]!);
  }
  return last;
}

export function unresolvedInDoubt(): VekRevertError {
  return new VekRevertError("VR2020", "unresolved_in_doubt");
}
