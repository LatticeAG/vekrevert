/** Parameterized SQL assembly from structured where/set/values. Values are never interpolated. */

import { VekRevertError, type CompensationStep, type JsonValue } from "@latticeag/vekrevert-core";
import type { StepContext, StepResult } from "../step.ts";

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

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new VekRevertError("VR3009", `unsafe identifier ${name}`);
  }
  return `"${name}"`;
}

function scalar(v: JsonValue | undefined): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  throw new VekRevertError("VR3009", "SQL value is not a scalar");
}

export function assembleSql(step: Extract<CompensationStep, { kind: "sql_statement" }>, resolved: JsonValue): {
  sql: string;
  params: Array<string | number | boolean | null>;
} {
  const rec = asRecord(resolved);
  const table = quoteIdent(stringify(rec.table));
  const params: Array<string | number | boolean | null> = [];

  if (step.statement === "DELETE") {
    const where = asRecord(rec.where);
    const keys = Object.keys(where);
    if (keys.length === 0) throw new VekRevertError("VR3009", "bare WHERE");
    const clause = keys.map((k) => `${quoteIdent(k)} = ?`).join(" AND ");
    for (const k of keys) params.push(scalar(where[k]));
    return { sql: `DELETE FROM ${table} WHERE ${clause}`, params };
  }

  if (step.statement === "UPDATE") {
    const set = asRecord(rec.set);
    const where = asRecord(rec.where);
    const setKeys = Object.keys(set);
    const whereKeys = Object.keys(where);
    if (setKeys.length === 0) throw new VekRevertError("VR3009", "UPDATE without SET");
    if (whereKeys.length === 0) throw new VekRevertError("VR3009", "bare WHERE");
    const setClause = setKeys.map((k) => `${quoteIdent(k)} = ?`).join(", ");
    const whereClause = whereKeys.map((k) => `${quoteIdent(k)} = ?`).join(" AND ");
    for (const k of setKeys) params.push(scalar(set[k]));
    for (const k of whereKeys) params.push(scalar(where[k]));
    return { sql: `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`, params };
  }

  const values = asRecord(rec.values);
  const keys = Object.keys(values);
  if (keys.length === 0) throw new VekRevertError("VR3009", "INSERT without values");
  const cols = keys.map(quoteIdent).join(", ");
  const placeholders = keys.map(() => "?").join(", ");
  for (const k of keys) params.push(scalar(values[k]));
  return { sql: `INSERT INTO ${table} (${cols}) VALUES (${placeholders})`, params };
}

function runOnHandle(db: NonNullable<StepContext["db"]>, sql: string, params: Array<string | number | boolean | null>): number {
  if (typeof db.prepare === "function") {
    const stmt = db.prepare(sql);
  const info = stmt.run(...(params as never[])) as { changes?: number | bigint };
    return Number(info.changes ?? 0);
  }
  throw new VekRevertError("VR5001", "db handle does not support prepare()");
}

export async function executeSql(step: CompensationStep, resolved: JsonValue, ctx: StepContext): Promise<StepResult> {
  if (step.kind !== "sql_statement") throw new VekRevertError("VR5001", `expected sql_statement, got ${step.kind}`);
  if (!ctx.db) throw new VekRevertError("VR5001", "sql step requires ctx.db");
  const assembled = assembleSql(step, resolved);
  const changes = runOnHandle(ctx.db, assembled.sql, assembled.params);
  if (changes < step.expect_rowcount.min || changes > step.expect_rowcount.max) {
    if (changes === 0 && step.expect_rowcount.min >= 1) {
      throw new VekRevertError("VR5006", `rowcount ${changes}`);
    }
    throw new VekRevertError("VR5001", `rowcount ${changes} outside ${step.expect_rowcount.min}..${step.expect_rowcount.max}`);
  }
  return { ok: true, kind: "sql_statement", sql: assembled.sql, rowcount: changes };
}
