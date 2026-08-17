import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyAction,
  classifyStructural,
  joinTier,
  TIER_ORDER,
  type ActionSignature,
  type ClassifyContext,
  type Tier,
  type TierEvidence,
} from "@latticeag/vekrevert-core";
import { classifyCases } from "./fixtures/classify/cases.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/classify");

function ctxFromCase(c: ReturnType<typeof classifyCases>[number]): ClassifyContext {
  const ctx: ClassifyContext = { ...(c.ctx ?? {}) };
  if (c.ctx?.manifestTier) {
    ctx.manifest = {
      id: "cmp_test@1",
      match: { kind: "fs", op: "write", path_glob: c.ctx.manifestGlob ?? "/var/app/data/**" },
      tier: c.ctx.manifestTier,
      binds: {},
      compensator: { kind: "declarative", steps: [{ kind: "noop", reason: "t" }] },
      leak: "none",
      cascade_risk: "none",
      reversal_completeness: "full",
      source: "builtin",
    } as ActionSignature;
  }
  return ctx;
}

describe("classify_corpus", () => {
  const cases = classifyCases();
  it("has 120 golden cases", () => {
    expect(cases).toHaveLength(120);
  });

  mkdirSync(fixtureDir, { recursive: true });
  for (const c of cases) {
    writeFileSync(join(fixtureDir, `${c.name}.json`), JSON.stringify(c, null, 2) + "\n");
  }

  for (const c of cases) {
    it(c.name, () => {
      const ctx = ctxFromCase(c);
      const rec = classifyAction(c.action, c.args, ctx);
      const structural = classifyStructural(c.action, c.args, ctx);
      expect(rec.tier, c.name).toBe(c.expected.tier);
      if (c.expected.scope_violation) expect(rec.scope_violation).toBe(true);
      if (c.expected.in_doubt) expect(structural.in_doubt).toBe(true);
    });
  }

  it("http_get_nobody fixture file exists", () => {
    const raw = JSON.parse(readFileSync(join(fixtureDir, "http_get_nobody.json"), "utf8"));
    expect(raw.expected.tier).toBe("T1");
  });
});
