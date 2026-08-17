import { describe, expect, it } from "vitest";
import {
  compilePlan,
  isPlanRejection,
  type ActionRef,
  type ActionSignature,
  type CompensationStep,
  type EffectReceipt,
} from "@latticeag/vekrevert-core";

const action: ActionRef = {
  kind: "sql",
  name: "sql.INSERT.app.invoices",
  target: "app",
  locality: "internal",
};

function receipt(): EffectReceipt {
  return {
    v: "vekrevert/v1",
    effect_id: "eff_sql",
    saga_id: "sag_sql",
    seq: 1,
    action,
    tier: "T2",
    classification: { tier: "T2", sources: [], reasons: [], candidates: [], scope_violation: false },
    args_observed: { statement: "INSERT", table: "invoices", dialect: "postgres" },
    args_hash: "sha256:x",
    intent_key: "sha256:x",
    result_observed: { id: 7, rowcount: 1 },
    bindings: { table: "invoices", id: "7", injected: "invoices; DROP TABLE users" },
    binding_paths: {},
    resource_keys: ["sql:postgres:app:invoices:id=7"],
    status: "landed",
    compensation_state: "available",
    capture: { fidelity: "full", interceptor: "test", sdk_version: "0.1.0", warnings: [] },
    leak: "none",
    cascade_risk: "none",
    opened_at: "1970-01-01T00:00:00.000Z",
    redactions: [],
    sealed: true,
    preimage: { kind: "sql_rows", truncated: false, rows: 1 },
  };
}

function sig(steps: CompensationStep[]): ActionSignature {
  return {
    id: "cmp_sql@1",
    match: { kind: "sql", statement: "INSERT", table: "invoices", dialect: "postgres" },
    tier: "T2",
    binds: {},
    compensator: { kind: "declarative", steps },
    leak: "none",
    cascade_risk: "none",
    reversal_completeness: "full",
    source: "registered",
  };
}

describe("sql_injection", () => {
  it("declarative plan cannot carry a raw statement string", () => {
    const compiled = compilePlan(
      receipt(),
      sig([
        {
          kind: "sql_statement",
          dialect: "postgres",
          statement: "DELETE FROM invoices WHERE id = 7" as never,
          table: { $ref: "receipt.bindings.table" },
          where: { id: { $ref: "receipt.bindings.id" } },
          expect_rowcount: { min: 1, max: 1 },
        },
      ]),
    );
    expect(isPlanRejection(compiled)).toBe(true);
    if (isPlanRejection(compiled)) {
      expect(["VR3005", "VR3009"]).toContain(compiled.error_code);
    }
  });

  it("extra sql text field is rejected", () => {
    const compiled = compilePlan(
      receipt(),
      sig([
        {
          kind: "sql_statement",
          dialect: "postgres",
          statement: "DELETE",
          table: { $ref: "receipt.bindings.table" },
          where: { id: { $ref: "receipt.bindings.id" } },
          expect_rowcount: { min: 1, max: 1 },
          sql: "DELETE FROM invoices; DROP TABLE users",
        } as unknown as CompensationStep,
      ]),
    );
    expect(isPlanRejection(compiled)).toBe(true);
    if (isPlanRejection(compiled)) {
      expect(["VR3005", "VR3009"]).toContain(compiled.error_code);
    }
  });

  it("resolved table carrying a second statement is VR3009", () => {
    const compiled = compilePlan(
      receipt(),
      sig([
        {
          kind: "sql_statement",
          dialect: "postgres",
          statement: "DELETE",
          table: { $ref: "receipt.bindings.injected" },
          where: { id: { $ref: "receipt.bindings.id" } },
          expect_rowcount: { min: 1, max: 1 },
        },
      ]),
    );
    expect(isPlanRejection(compiled)).toBe(true);
    if (isPlanRejection(compiled)) {
      expect(compiled.error_code).toBe("VR3009");
    }
  });

  it("structured DELETE with refs is representable", () => {
    const compiled = compilePlan(
      receipt(),
      sig([
        {
          kind: "sql_statement",
          dialect: "postgres",
          statement: "DELETE",
          table: { $ref: "receipt.bindings.table" },
          where: { id: { $ref: "receipt.bindings.id" } },
          expect_rowcount: { min: 1, max: 1 },
        },
      ]),
    );
    expect(isPlanRejection(compiled)).toBe(false);
  });
});
