#!/usr/bin/env tsx
/** Generate frozen conformance vectors from the TS implementation (D8). */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  hashJcs,
  sha256Prefixed,
  genesisHash,
  deriveEffectId,
  deriveIdempotencyKey,
  derivePlanHash,
  chainEvent,
  verifyChain,
} from "@latticeag/vekrevert-core";
import type { JsonValue } from "@latticeag/vekrevert-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function write(rel: string, obj: unknown): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

const jcsCases: Array<{ name: string; input: JsonValue; canonical: string }> = [];
const inputs: Array<{ name: string; input: JsonValue }> = [
  { name: "object_key_sort", input: { b: 2, a: 1 } },
  { name: "nested", input: [1, { z: 1, a: 0 }, null] },
  { name: "empty_and_euro", input: { "": 0, "\u20ac": "Euro" } },
  { name: "scalars", input: { t: true, f: false, n: null, i: 0, x: 1.5, s: "quote\"slash\\" } },
  { name: "unicode_escape_ctrl", input: { k: "a\nb\tc" } },
];
for (const c of inputs) {
  jcsCases.push({ name: c.name, input: c.input, canonical: canonicalize(c.input) });
}
write("conformance/jcs/cases.json", { v: "vekrevert/v1", cases: jcsCases });

const hashingCases = jcsCases.map((c) => ({
  name: c.name,
  input: c.input,
  sha256: hashJcs(c.input),
}));
write("conformance/hashing/cases.json", { v: "vekrevert/v1", cases: hashingCases });

const args = { customer: "acme", amount: 450 };
const args_hash = hashJcs(args);
const effect_id = deriveEffectId({
  saga_id: "sag_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  seq: 1,
  action_name: "http.POST.api.example.com/v1/invoices",
  args_hash,
});
const plan_hash = derivePlanHash({
  effect_id,
  compensator_id: "cmp_http_create@1",
  origin: "builtin",
  steps: [{ kind: "http_request", method: "DELETE" }],
});
const idem = deriveIdempotencyKey({
  saga_id: "sag_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  effect_seq: 1,
  compensator_id: "cmp_http_create@1",
  plan_hash,
  step_index: 0,
});
write("conformance/ids/cases.json", {
  v: "vekrevert/v1",
  cases: [
    {
      name: "effect_id_invoice",
      saga_id: "sag_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      seq: 1,
      action_name: "http.POST.api.example.com/v1/invoices",
      args,
      args_hash,
      effect_id,
    },
    {
      name: "plan_hash_and_idempotency",
      effect_id,
      compensator_id: "cmp_http_create@1",
      origin: "builtin",
      steps: [{ kind: "http_request", method: "DELETE" }],
      plan_hash,
      saga_id: "sag_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      effect_seq: 1,
      step_index: 0,
      idempotency_key: idem,
    },
    {
      name: "genesis",
      saga_id: "sag_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      genesis: genesisHash("sag_01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    },
  ],
});

const sagaId = "sag_01ARZ3NDEKTSV4RRFFQ69G5FAV";
let prev = genesisHash(sagaId);
const events = [];
const types = ["saga_opened", "effect_opened", "effect_closed"] as const;
for (let i = 0; i < 3; i++) {
  const chained = chainEvent(
    {
      v: "vekrevert/v1" as const,
      id: `evt_01TEST00000000000000000${i + 1}`,
      type: types[i]!,
      ts: `2026-08-17T10:00:0${i}.000Z`,
      saga_id: sagaId,
      chain_seq: i + 1,
      actor: { kind: "system" as const, id: "vekrevert" },
      payload: { n: i + 1 },
      prev_hash: prev,
    },
    prev,
  );
  events.push(chained);
  prev = chained.hash;
}
const verified = verifyChain(events);
write("conformance/chain/three_event_saga.json", {
  v: "vekrevert/v1",
  saga_id: sagaId,
  genesis: genesisHash(sagaId),
  events,
  verify: verified,
});

process.stdout.write("conformance vectors written\n");
void sha256Prefixed;
