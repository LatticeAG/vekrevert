/** C2 cmp_sql_row@1: invert INSERT/UPDATE/DELETE with structured SQL steps. */

import type {
  ActionSignature,
  ArgValue,
  CompensationStep,
  EffectReceipt,
  JsonValue,
  Postcondition,
  SqlDialect,
} from "@latticeag/vekrevert-core";
import { classifySql } from "@latticeag/vekrevert-core";

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, JsonValue>;
  return {};
}

function str(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function pkCol(receipt: EffectReceipt): string {
  for (const k of receipt.resource_keys ?? []) {
    if (!k.startsWith("sql:")) continue;
    const pkPart = k.split(":").slice(4).join(":");
    const col = pkPart.split(",")[0]?.split("=")[0];
    if (col) return col;
  }
  if (receipt.bindings.id !== undefined) return "id";
  if (receipt.bindings.pk !== undefined) return "id";
  return "id";
}

function pkValueRef(receipt: EffectReceipt): ArgValue {
  if (receipt.bindings.pk !== undefined) return { $ref: "receipt.bindings.pk" };
  if (receipt.bindings.id !== undefined) return { $ref: "receipt.bindings.id" };
  return { $ref: "receipt.result.$.id" };
}

function tableRef(receipt: EffectReceipt): ArgValue {
  if (receipt.bindings.table !== undefined) return { $ref: "receipt.bindings.table" };
  return { $ref: "receipt.args.table" };
}

function dialectOf(receipt: EffectReceipt): SqlDialect {
  const d = str(asRecord(receipt.args_observed).dialect);
  if (d === "sqlite" || d === "postgres" || d === "mysql" || d === "unknown") return d;
  return "unknown";
}

function statementOf(receipt: EffectReceipt): string {
  const args = asRecord(receipt.args_observed);
  const direct = str(args.statement);
  if (direct) return direct.toUpperCase();
  const sql = str(args.sql);
  if (sql) return classifySql(sql).kind;
  const m = receipt.action.name.match(/^sql\.([A-Z]+)\./);
  return m?.[1] ?? "";
}

export function planForSql(receipt: EffectReceipt): { steps: CompensationStep[]; postconditions: Postcondition[] } {
  const statement = statementOf(receipt);
  const dialect = dialectOf(receipt);
  const table = tableRef(receipt);
  const col = pkCol(receipt);
  const pk = pkValueRef(receipt);
  const result = asRecord(receipt.result_observed);
  const pre = asRecord(result.pre);
  const post = asRecord(result.post);

  if (statement === "INSERT") {
    return {
      steps: [
        {
          kind: "sql_statement",
          dialect,
          statement: "DELETE",
          table,
          where: { [col]: pk },
          expect_rowcount: { min: 1, max: 1 },
        },
      ],
      postconditions: [{ step_index: 0, kind: "row_count", expected: 1, required: true }],
    };
  }

  if (statement === "UPDATE") {
    const set: Record<string, ArgValue> = {};
    const where: Record<string, ArgValue> = { [col]: pk };
    for (const key of Object.keys(pre)) {
      set[key] = { $ref: `receipt.result.$.pre.${key}` };
    }
    for (const key of Object.keys(post)) {
      where[key] = { $ref: `receipt.result.$.post.${key}` };
    }
    if (Object.keys(set).length === 0) {
      set[col] = pk;
    }
    return {
      steps: [
        {
          kind: "sql_statement",
          dialect,
          statement: "UPDATE",
          table,
          set,
          where,
          expect_rowcount: { min: 1, max: 1 },
        },
      ],
      postconditions: [{ step_index: 0, kind: "row_count", expected: 1, required: true }],
    };
  }

  const values: Record<string, ArgValue> = {};
  for (const key of Object.keys(pre)) {
    values[key] = { $ref: `receipt.result.$.pre.${key}` };
  }
  if (Object.keys(values).length === 0) {
    values[col] = pk;
  }
  return {
    steps: [
      {
        kind: "sql_statement",
        dialect,
        statement: "INSERT",
        table,
        values,
        expect_rowcount: { min: 1, max: 1 },
      },
    ],
    postconditions: [{ step_index: 0, kind: "row_count", expected: 1, required: true }],
  };
}

const insertTemplate = planForSql({
  args_observed: { statement: "INSERT", table: "t", dialect: "sqlite" },
  bindings: { pk: 1, table: "t" },
  result_observed: { id: 1 },
  resource_keys: ["sql:sqlite:app:t:id=1"],
  action: { kind: "sql", name: "sql.INSERT.app.t", target: "app", locality: "internal" },
} as unknown as EffectReceipt);

export const sqlRow: ActionSignature = {
  id: "cmp_sql_row@1",
  match: { kind: "sql", statement: ["INSERT", "UPDATE", "DELETE"], table: "*" },
  tier: "T2",
  binds: {
    table: { from: "args.table", required: false },
    pk: { from: "result.$.id", required: false },
    id: { from: "result.$.id", required: false },
  },
  preimage: { required: false, kind: "sql_rows" },
  compensator: {
    kind: "declarative",
    steps: insertTemplate.steps,
    postconditions: insertTemplate.postconditions,
  },
  leak: "downstream_effects",
  cascade_risk: "high",
  independent: false,
  reversal_completeness: "full",
  source: "builtin",
};
