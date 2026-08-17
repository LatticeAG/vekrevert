/** Phase 5 step dispatcher. Full executePlan is Phase 6. */

import {
  isRef,
  resolveRef,
  VekRevertError,
  type ActionSignature,
  type CompensationStep,
  type EffectReceipt,
  type JsonValue,
} from "@latticeag/vekrevert-core";
import type { Ledger } from "../ledger/types.ts";
import { executeFs } from "./steps/fs.ts";
import { executeHttp } from "./steps/http.ts";
import { executeMcp } from "./steps/mcp.ts";
import { executeSql } from "./steps/sql.ts";

export interface StepDbHandle {
  prepare: (sql: string) => { run: (...params: never[]) => { changes?: number | bigint } };
}

export interface StepContext {
  receipt: EffectReceipt;
  signature?: ActionSignature;
  attempt_id: string;
  ledger?: Ledger;
  credentials?: { resolve(name: string): string | undefined };
  db?: StepDbHandle;
  fetch?: typeof fetch;
  mcpCall?: (tool: string, args: JsonValue) => Promise<unknown> | unknown;
  permits?: string[];
  now?: Date;
  writableRoots?: string[];
}

export type StepResult = {
  ok: true;
  kind: CompensationStep["kind"];
  path?: string;
  sha256?: string;
  absent?: boolean;
  status?: number;
  compensated_via_404?: boolean;
  sql?: string;
  rowcount?: number;
  tool?: string;
  result?: unknown;
};

function checkWindow(ctx: StepContext): void {
  const until = ctx.receipt.compensable_until;
  if (!until) return;
  const t = Date.parse(until);
  const now = (ctx.now ?? new Date()).getTime();
  if (!Number.isNaN(t) && t < now) throw new VekRevertError("VR5007", "window_expired");
}

function resolveDeep(v: JsonValue, ctx: StepContext): JsonValue {
  if (isRef(v)) {
    if (v.$ref.startsWith("credential.")) return v as unknown as JsonValue;
    if (v.$ref === "runtime.idempotency_key") return ctx.attempt_id;
    const r = resolveRef(v, ctx.receipt, ctx.signature, ctx.signature?.source);
    if (!r.ok) throw new VekRevertError(r.rejection.error_code, r.rejection.detail);
    return r.value as JsonValue;
  }
  if (Array.isArray(v)) return v.map((x) => resolveDeep(x, ctx));
  if (v && typeof v === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, val] of Object.entries(v)) out[k] = resolveDeep(val as JsonValue, ctx);
    return out;
  }
  return v;
}

export async function executeStep(step: CompensationStep, ctx: StepContext): Promise<StepResult> {
  checkWindow(ctx);
  const resolved = resolveDeep(step as unknown as JsonValue, ctx);
  switch (step.kind) {
    case "fs_restore":
    case "fs_rename":
      return executeFs(step, resolved, ctx);
    case "sql_statement":
      return executeSql(step, resolved, ctx);
    case "http_request":
      return executeHttp(step, resolved, ctx);
    case "mcp_tool_call":
      return executeMcp(step, resolved, ctx);
    case "noop":
      return { ok: true, kind: "noop" };
    case "manual":
      throw new VekRevertError("VR1010", step.instructions);
  }
}
