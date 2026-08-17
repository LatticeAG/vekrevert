import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  hashJcs,
  genesisHash,
  deriveEffectId,
  derivePlanHash,
  deriveIdempotencyKey,
  chainEvent,
  verifyChain,
  joinTier,
  sealHash,
  VekRevertError,
  type TierEvidence,
} from "@latticeag/vekrevert-core";
import { openMemoryLedger } from "@latticeag/vekrevert";
import type { JsonValue } from "@latticeag/vekrevert-core";

const root = join(import.meta.dirname, "..");

function loadJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

function dirHasFiles(rel: string): boolean {
  const p = join(root, rel);
  if (!existsSync(p)) return false;
  return readdirSync(p).some((f) => f.endsWith(".json"));
}

describe("conformance/jcs", () => {
  if (!dirHasFiles("conformance/jcs")) return;
  it("matches frozen canonical forms", () => {
    const doc = loadJson("conformance/jcs/cases.json") as {
      cases: Array<{ name: string; input: JsonValue; canonical: string }>;
    };
    for (const c of doc.cases) {
      expect(canonicalize(c.input), c.name).toBe(c.canonical);
    }
  });
});

describe("conformance/hashing", () => {
  if (!dirHasFiles("conformance/hashing")) return;
  it("matches frozen sha256 of JCS", () => {
    const doc = loadJson("conformance/hashing/cases.json") as {
      cases: Array<{ name: string; input: JsonValue; sha256: string }>;
    };
    for (const c of doc.cases) {
      expect(hashJcs(c.input), c.name).toBe(c.sha256);
    }
  });
});

describe("conformance/ids", () => {
  if (!dirHasFiles("conformance/ids")) return;
  it("matches frozen effect_id / plan_hash / idempotency_key / genesis", () => {
    const doc = loadJson("conformance/ids/cases.json") as { cases: Array<Record<string, unknown>> };
    for (const c of doc.cases) {
      if (c.name === "effect_id_invoice") {
        expect(
          deriveEffectId({
            saga_id: c.saga_id as string,
            seq: c.seq as number,
            action_name: c.action_name as string,
            args_hash: c.args_hash as string,
          }),
        ).toBe(c.effect_id);
        expect(hashJcs(c.args as JsonValue)).toBe(c.args_hash);
      }
      if (c.name === "plan_hash_and_idempotency") {
        expect(
          derivePlanHash({
            effect_id: c.effect_id as string,
            compensator_id: c.compensator_id as string,
            origin: c.origin as string,
            steps: c.steps as JsonValue,
          }),
        ).toBe(c.plan_hash);
        expect(
          deriveIdempotencyKey({
            saga_id: c.saga_id as string,
            effect_seq: c.effect_seq as number,
            compensator_id: c.compensator_id as string,
            plan_hash: c.plan_hash as string,
            step_index: c.step_index as number,
          }),
        ).toBe(c.idempotency_key);
      }
      if (c.name === "genesis") {
        expect(genesisHash(c.saga_id as string)).toBe(c.genesis);
      }
    }
  });
});

describe("conformance/chain", () => {
  if (!dirHasFiles("conformance/chain")) return;
  it("matches a 3-event saga chain and verifies", () => {
    const doc = loadJson("conformance/chain/three_event_saga.json") as {
      saga_id: string;
      genesis: string;
      events: Array<Parameters<typeof chainEvent>[0] & { hash: string; prev_hash: string }>;
    };
    expect(genesisHash(doc.saga_id)).toBe(doc.genesis);
    let prev = doc.genesis;
    for (const ev of doc.events) {
      const { hash: _h, ...rest } = ev;
      const chained = chainEvent(rest, prev);
      expect(chained.hash).toBe(ev.hash);
      expect(chained.prev_hash).toBe(ev.prev_hash);
      prev = chained.hash;
    }
    expect(verifyChain(doc.events)).toEqual({ ok: true });
  });
});

describe("conformance/taxonomy", () => {
  if (!dirHasFiles("conformance/taxonomy")) return;
  it("join fixtures match joinTier", () => {
    const doc = loadJson("conformance/taxonomy/join.json") as {
      cases: Array<{ name: string; evidence: TierEvidence; tier: string }>;
    };
    for (const c of doc.cases) {
      expect(joinTier(c.evidence).tier, c.name).toBe(c.tier);
    }
  });
});

describe("conformance/receipts", () => {
  if (!dirHasFiles("conformance/receipts")) return;
  it("sealed invoice receipt seal_hash matches", () => {
    const receipt = loadJson("conformance/receipts/invoice_create.json") as Record<string, unknown>;
    const { seal_hash, ...unsealed } = receipt;
    expect(sealHash(unsealed as JsonValue)).toBe(seal_hash);
    expect(receipt.v).toBe("vekrevert/v1");
    expect(receipt.sealed).toBe(true);
    expect(receipt.effect_id).toBe("eff_S7DW2SEVFCH3C67WD8Z6J11J7Y");
  });
});

describe("memory ledger production guard", () => {
  it("throws VR2001 when NODE_ENV=production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => openMemoryLedger()).toThrow(VekRevertError);
      try {
        openMemoryLedger();
      } catch (e) {
        expect((e as VekRevertError).code).toBe("VR2001");
      }
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
