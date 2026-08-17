import { describe, expect, it } from "vitest";
import {
  compilePlan,
  isPlanRejection,
  type ActionRef,
  type ActionSignature,
  type CompensationStep,
  type EffectReceipt,
  type JsonValue,
} from "@latticeag/vekrevert-core";

const httpAction: ActionRef = {
  kind: "http",
  name: "http.POST.api.example.com/v1/items",
  target: "api.example.com",
  locality: "external",
};

function receipt(over: Partial<EffectReceipt> = {}): EffectReceipt {
  return {
    v: "vekrevert/v1",
    effect_id: "eff_prov",
    saga_id: "sag_prov",
    seq: 1,
    action: httpAction,
    tier: "T3",
    classification: { tier: "T3", sources: [], reasons: [], candidates: [], scope_violation: false },
    args_observed: { method: "POST", url: "https://api.example.com/v1/items" },
    args_hash: "sha256:x",
    intent_key: "sha256:x",
    result_observed: { id: "it_1", status: 201 },
    bindings: {
      resource_url: "https://api.example.com/v1/items/it_1",
      id: "it_1",
      table: "invoices",
      pk: "7",
      path: "/var/data/config.yaml",
      from: "/var/data/a",
      to: "/var/data/b",
      tool: "chat.delete",
    },
    binding_paths: {},
    resource_keys: [
      "http:api.example.com:/v1/items/it_1",
      "sql:postgres:app:invoices:id=7",
      "fs:/var/data/config.yaml",
      "fs:/var/data/a",
      "fs:/var/data/b",
      "mcp:slack:chat.delete:x",
    ],
    status: "landed",
    compensation_state: "available",
    capture: { fidelity: "full", interceptor: "test", sdk_version: "0.1.0", warnings: [] },
    leak: "none",
    cascade_risk: "none",
    opened_at: "1970-01-01T00:00:00.000Z",
    redactions: [],
    sealed: true,
    preimage: { kind: "fs_bytes", truncated: false, blob_id: "blob_x", meta: { realpath: "/var/data/config.yaml" } },
    ...over,
  };
}

function signature(steps: CompensationStep[]): ActionSignature {
  return {
    id: "cmp_prov@1",
    match: { kind: "http", method: "POST", url_pattern: "https://api.example.com/v1/items" },
    tier: "T3",
    binds: {},
    compensator: { kind: "declarative", steps },
    leak: "none",
    cascade_risk: "none",
    reversal_completeness: "full",
    source: "registered",
    constants: { refund_url: "https://api.example.com/v1/refunds" },
    credentials: ["token"],
    permits: ["chat.delete"],
  };
}

const REF = (s: string) => ({ $ref: s as `receipt.bindings.${string}` });

const POSITIONS: Array<{ kind: CompensationStep["kind"]; path: string; step: (lit: JsonValue) => CompensationStep }> = [
  {
    kind: "http_request",
    path: "url",
    step: (lit) => ({
      kind: "http_request",
      method: "DELETE",
      url: lit as never,
      expect: { status_in: [200] },
    }),
  },
  {
    kind: "http_request",
    path: "headers.Authorization",
    step: (lit) => ({
      kind: "http_request",
      method: "DELETE",
      url: REF("receipt.bindings.resource_url"),
      headers: { Authorization: lit as never },
      expect: { status_in: [200] },
    }),
  },
  {
    kind: "http_request",
    path: "body",
    step: (lit) => ({
      kind: "http_request",
      method: "POST",
      url: REF("receipt.bindings.resource_url"),
      body: lit as never,
      expect: { status_in: [200] },
    }),
  },
  {
    kind: "http_request",
    path: "body.charge",
    step: (lit) => ({
      kind: "http_request",
      method: "POST",
      url: REF("receipt.bindings.resource_url"),
      body: { charge: lit as never },
      expect: { status_in: [200] },
    }),
  },
  {
    kind: "sql_statement",
    path: "table",
    step: (lit) => ({
      kind: "sql_statement",
      dialect: "postgres",
      statement: "DELETE",
      table: lit as never,
      where: { id: REF("receipt.bindings.pk") },
      expect_rowcount: { min: 1, max: 1 },
    }),
  },
  {
    kind: "sql_statement",
    path: "where.id",
    step: (lit) => ({
      kind: "sql_statement",
      dialect: "postgres",
      statement: "DELETE",
      table: REF("receipt.bindings.table"),
      where: { id: lit as never },
      expect_rowcount: { min: 1, max: 1 },
    }),
  },
  {
    kind: "sql_statement",
    path: "set.col",
    step: (lit) => ({
      kind: "sql_statement",
      dialect: "postgres",
      statement: "UPDATE",
      table: REF("receipt.bindings.table"),
      where: { id: REF("receipt.bindings.pk") },
      set: { col: lit as never },
      expect_rowcount: { min: 1, max: 1 },
    }),
  },
  {
    kind: "sql_statement",
    path: "values.col",
    step: (lit) => ({
      kind: "sql_statement",
      dialect: "postgres",
      statement: "INSERT",
      table: REF("receipt.bindings.table"),
      values: { col: lit as never },
      expect_rowcount: { min: 1, max: 1 },
    }),
  },
  {
    kind: "fs_restore",
    path: "path",
    step: (lit) => ({
      kind: "fs_restore",
      path: lit as never,
      source: { $ref: "receipt.preimage.blob" },
    }),
  },
  {
    kind: "fs_restore",
    path: "source",
    step: (lit) => ({
      kind: "fs_restore",
      path: REF("receipt.bindings.path"),
      source: lit as never,
    }),
  },
  {
    kind: "fs_rename",
    path: "from",
    step: (lit) => ({
      kind: "fs_rename",
      from: lit as never,
      to: REF("receipt.bindings.to"),
    }),
  },
  {
    kind: "fs_rename",
    path: "to",
    step: (lit) => ({
      kind: "fs_rename",
      from: REF("receipt.bindings.from"),
      to: lit as never,
    }),
  },
  {
    kind: "mcp_tool_call",
    path: "tool",
    step: (lit) => ({
      kind: "mcp_tool_call",
      tool: lit as never,
      args: { id: REF("receipt.bindings.id") },
    }),
  },
  {
    kind: "mcp_tool_call",
    path: "args",
    step: (lit) => ({
      kind: "mcp_tool_call",
      tool: REF("receipt.bindings.tool"),
      args: lit as never,
    }),
  },
  {
    kind: "mcp_tool_call",
    path: "args.id",
    step: (lit) => ({
      kind: "mcp_tool_call",
      tool: REF("receipt.bindings.tool"),
      args: { id: lit as never },
    }),
  },
];

const LITERALS: JsonValue[] = ["ch_123", 42, true];

describe("provenance_exhaustive", () => {
  for (const pos of POSITIONS) {
    for (const lit of LITERALS) {
      it(`${pos.kind} ${pos.path} literal ${JSON.stringify(lit)} => VR3007`, () => {
        const compiled = compilePlan(receipt(), signature([pos.step(lit)]));
        expect(isPlanRejection(compiled), `${pos.path} should reject`).toBe(true);
        if (isPlanRejection(compiled)) {
          expect(compiled.error_code).toBe("VR3007");
        }
      });
    }
  }

  it("noop extra identifier field is rejected", () => {
    const compiled = compilePlan(
      receipt(),
      signature([{ kind: "noop", reason: "skip", path: "/etc/passwd" } as unknown as CompensationStep]),
    );
    expect(isPlanRejection(compiled)).toBe(true);
    if (isPlanRejection(compiled)) {
      expect(["VR3005", "VR3007"]).toContain(compiled.error_code);
    }
  });

  it("manual extra url field is rejected", () => {
    const compiled = compilePlan(
      receipt(),
      signature([
        {
          kind: "manual",
          instructions: "call support",
          suggested_actions: ["refund"],
          url: "https://evil.example/steal",
        } as unknown as CompensationStep,
      ]),
    );
    expect(isPlanRejection(compiled)).toBe(true);
    if (isPlanRejection(compiled)) {
      expect(["VR3005", "VR3007"]).toContain(compiled.error_code);
    }
  });

  it("valid ref-only http plan compiles", () => {
    const compiled = compilePlan(
      receipt(),
      signature([
        {
          kind: "http_request",
          method: "DELETE",
          url: REF("receipt.bindings.resource_url"),
          expect: { status_in: [200, 404], treat_404_as_compensated: true },
        },
      ]),
    );
    expect(isPlanRejection(compiled)).toBe(false);
  });
});
