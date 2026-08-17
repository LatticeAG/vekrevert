import { describe, expect, it } from "vitest";
import { joinTier, maxTier, TIER_ORDER, type Tier, type TierEvidence } from "@latticeag/vekrevert-core";

const TIERS: Tier[] = ["T1", "T2", "T3", "T4"];

function base(over: Partial<TierEvidence> = {}): TierEvidence {
  return {
    structural: "T1",
    locality: "T1",
    scopeViolation: false,
    compensatorMatched: true,
    reasons: [],
    ...over,
  };
}

function withModel(x: TierEvidence, m: Tier): TierEvidence {
  return { ...x, model: { tier: m } };
}

describe("taxonomy_monotonic", () => {
  it("model can only escalate", () => {
    for (const s of TIERS) {
      for (const loc of TIERS) {
        for (const man of [...TIERS, undefined]) {
          for (const sv of [false, true]) {
            const x = base({
              structural: s,
              locality: loc,
              manifest: man ? { tier: man } : undefined,
              scopeViolation: sv,
            });
            const joined = joinTier(x).tier;
            for (const m of TIERS) {
              const withM = joinTier(withModel(x, m)).tier;
              expect(TIER_ORDER[withM]).toBeGreaterThanOrEqual(TIER_ORDER[joined]);
            }
          }
        }
      }
    }
  });

  it("scopeViolation implies T4", () => {
    for (const s of TIERS) {
      const r = joinTier(base({ structural: s, locality: s, scopeViolation: true, manifest: { tier: "T1" } }));
      expect(r.tier).toBe("T4");
    }
  });

  it("maxTier is a join on the severity order", () => {
    expect(maxTier("T1", "T4")).toBe("T4");
    expect(maxTier("T3", "T2")).toBe("T3");
  });
});
