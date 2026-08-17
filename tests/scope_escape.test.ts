import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compilePlan,
  isPlanRejection,
  type ActionRef,
  type ActionSignature,
  type CompensationStep,
  type EffectReceipt,
} from "@latticeag/vekrevert-core";

function baseReceipt(over: Partial<EffectReceipt> = {}): EffectReceipt {
  const action: ActionRef = over.action ?? {
    kind: "http",
    name: "http.POST.api.stripe.com/v1/charges",
    target: "api.stripe.com",
    locality: "external",
  };
  return {
    v: "vekrevert/v1",
    effect_id: "eff_scope",
    saga_id: "sag_scope",
    seq: 1,
    action,
    tier: "T3",
    classification: { tier: "T3", sources: [], reasons: [], candidates: [], scope_violation: false },
    args_observed: { method: "POST", url: "https://api.stripe.com/v1/charges" },
    args_hash: "sha256:x",
    intent_key: "sha256:x",
    result_observed: { id: "ch_1", status: 200 },
    bindings: {
      resource_url: "https://api.stripe.com/v1/charges/ch_1",
      evil: "https://api.stripe.com@evil.com/v1/charges/ch_1",
    },
    binding_paths: {},
    resource_keys: ["http:api.stripe.com:/v1/charges/ch_1"],
    status: "landed",
    compensation_state: "available",
    capture: { fidelity: "full", interceptor: "test", sdk_version: "0.1.0", warnings: [] },
    leak: "none",
    cascade_risk: "none",
    opened_at: "1970-01-01T00:00:00.000Z",
    redactions: [],
    sealed: true,
    ...over,
  };
}

function sig(steps: CompensationStep[], extra: Partial<ActionSignature> = {}): ActionSignature {
  return {
    id: "cmp_scope@1",
    match: { kind: "http", method: "POST", url_pattern: "https://api.stripe.com/v1/charges" },
    tier: "T3",
    binds: {},
    compensator: { kind: "declarative", steps },
    leak: "none",
    cascade_risk: "none",
    reversal_completeness: "full",
    source: "registered",
    ...extra,
  };
}

function expectClosed(code: "VR3008" | "VR3009", compiled: ReturnType<typeof compilePlan>) {
  expect(isPlanRejection(compiled)).toBe(true);
  if (isPlanRejection(compiled)) {
    expect(["VR3008", "VR3009"]).toContain(compiled.error_code);
    expect(compiled.error_code).toBe(code);
  }
}

describe("scope_escape", () => {
  it("../ traversal => VR3008", () => {
    const r = baseReceipt({
      action: { kind: "fs", name: "fs.write./var/data/config.yaml", target: "/var/data/config.yaml", locality: "internal" },
      args_observed: { op: "write", path: "/var/data/config.yaml", realpath: "/var/data/config.yaml" },
      bindings: { path: "/var/data/../etc/passwd" },
      resource_keys: ["fs:/var/data/config.yaml"],
      preimage: { kind: "fs_bytes", truncated: false, blob_id: "blob_x", meta: { realpath: "/var/data/config.yaml" } },
    });
    const compiled = compilePlan(
      r,
      sig([
        {
          kind: "fs_restore",
          path: { $ref: "receipt.bindings.path" },
          source: { $ref: "receipt.preimage.blob" },
        },
      ]),
    );
    expectClosed("VR3008", compiled);
  });

  it("symlink escape => VR3008", () => {
    const dir = mkdtempSync(join(tmpdir(), "vekrevert-scope-"));
    const safe = join(dir, "safe.txt");
    const outside = join(dir, "outside.txt");
    const link = join(dir, "link.txt");
    writeFileSync(safe, "ok");
    writeFileSync(outside, "no");
    symlinkSync(outside, link);
    const r = baseReceipt({
      action: { kind: "fs", name: `fs.write.${safe}`, target: safe, locality: "internal" },
      args_observed: { op: "write", path: safe, realpath: safe },
      bindings: { path: link },
      resource_keys: [`fs:${safe}`],
      preimage: { kind: "fs_bytes", truncated: false, blob_id: "blob_x", meta: { realpath: safe } },
    });
    const compiled = compilePlan(
      r,
      sig([
        {
          kind: "fs_restore",
          path: { $ref: "receipt.bindings.path" },
          source: { $ref: "receipt.preimage.blob" },
        },
      ]),
    );
    expectClosed("VR3008", compiled);
  });

  it("URL userinfo https://api.stripe.com@evil.com/ => VR3008", () => {
    const compiled = compilePlan(
      baseReceipt(),
      sig([
        {
          kind: "http_request",
          method: "DELETE",
          url: { $ref: "receipt.bindings.evil" },
          expect: { status_in: [200] },
        },
      ]),
    );
    expectClosed("VR3008", compiled);
  });

  it("host-case => VR3008", () => {
    const r = baseReceipt({
      bindings: {
        resource_url: "https://api.stripe.com/v1/charges/ch_1",
        alt: "https://API.STRIPE.COM/v1/charges/ch_1",
      },
    });
    const compiled = compilePlan(
      r,
      sig([
        {
          kind: "http_request",
          method: "DELETE",
          url: { $ref: "receipt.bindings.alt" },
          expect: { status_in: [200] },
        },
      ]),
    );
    expectClosed("VR3008", compiled);
  });

  it("trailing-dot host => VR3008", () => {
    const r = baseReceipt({
      bindings: {
        resource_url: "https://api.stripe.com/v1/charges/ch_1",
        alt: "https://api.stripe.com./v1/charges/ch_1",
      },
    });
    const compiled = compilePlan(
      r,
      sig([
        {
          kind: "http_request",
          method: "DELETE",
          url: { $ref: "receipt.bindings.alt" },
          expect: { status_in: [200] },
        },
      ]),
    );
    expectClosed("VR3008", compiled);
  });

  it("IDN homoglyph host => VR3008", () => {
    const r = baseReceipt({
      bindings: {
        resource_url: "https://api.stripe.com/v1/charges/ch_1",
        alt: "https://api.strıpe.com/v1/charges/ch_1",
      },
    });
    const compiled = compilePlan(
      r,
      sig([
        {
          kind: "http_request",
          method: "DELETE",
          url: { $ref: "receipt.bindings.alt" },
          expect: { status_in: [200] },
        },
      ]),
    );
    expectClosed("VR3008", compiled);
  });

  it("WHERE-less SQL => VR3008 or VR3009", () => {
    const r = baseReceipt({
      action: { kind: "sql", name: "sql.INSERT.app.invoices", target: "app", locality: "internal" },
      args_observed: { statement: "INSERT", table: "invoices", dialect: "postgres" },
      bindings: { table: "invoices", id: "7" },
      resource_keys: ["sql:postgres:app:invoices:id=7"],
    });
    const compiled = compilePlan(
      r,
      sig([
        {
          kind: "sql_statement",
          dialect: "postgres",
          statement: "DELETE",
          table: { $ref: "receipt.bindings.table" },
          expect_rowcount: { min: 1, max: 1 },
        },
      ]),
    );
    expect(isPlanRejection(compiled)).toBe(true);
    if (isPlanRejection(compiled)) {
      expect(["VR3008", "VR3009"]).toContain(compiled.error_code);
    }
  });

  it("rowcount over-expect => VR3008", () => {
    const r = baseReceipt({
      action: { kind: "sql", name: "sql.UPDATE.app.invoices", target: "app", locality: "internal" },
      args_observed: { statement: "UPDATE", table: "invoices", dialect: "postgres" },
      bindings: { table: "invoices", id: "7" },
      resource_keys: ["sql:postgres:app:invoices:id=7"],
      preimage: { kind: "sql_rows", truncated: false, rows: 1 },
    });
    const compiled = compilePlan(
      r,
      sig([
        {
          kind: "sql_statement",
          dialect: "postgres",
          statement: "UPDATE",
          table: { $ref: "receipt.bindings.table" },
          where: { id: { $ref: "receipt.bindings.id" } },
          set: { n: { $ref: "receipt.bindings.id" } },
          expect_rowcount: { min: 1, max: 9999 },
        },
      ]),
    );
    expectClosed("VR3008", compiled);
  });
});
