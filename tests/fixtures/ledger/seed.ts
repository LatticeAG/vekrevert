/** Deterministic sag_fixture events plus a helper that seeds a ledger directory. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chainEvent, genesisHash, canonicalize, type JsonValue } from "@latticeag/vekrevert-core";
import type { ReceiptEvent } from "@latticeag/vekrevert-events";
import { openLedger } from "../../../sdk-ts/src/ledger/open.ts";

export const FIXTURE_SAGA_ID = "sag_fixture";

const ACTOR = { kind: "system" as const, id: "vekrevert" };
const T0 = Date.parse("2026-08-17T15:00:00.000Z");

function ts(n: number): string {
  return new Date(T0 + n * 1000).toISOString();
}

function evtId(n: number): string {
  return `evt_01FXTR000000000000000${String(n).padStart(5, "0")}`;
}

export function fixtureEvents(): ReceiptEvent[] {
  const saga = FIXTURE_SAGA_ID;
  const genesis = genesisHash(saga);
  const events: ReceiptEvent[] = [];
  let prev = genesis;

  const specs: Array<Omit<ReceiptEvent, "hash" | "prev_hash">> = [
    {
      v: "vekrevert/v1",
      id: evtId(1),
      type: "saga_opened",
      ts: ts(0),
      saga_id: saga,
      chain_seq: 1,
      actor: ACTOR,
      payload: { sdk_version: "0.1.0", key: "fixture", agent_id: "fixture-agent" },
    },
    {
      v: "vekrevert/v1",
      id: evtId(2),
      type: "reversibility_classified",
      ts: ts(1),
      saga_id: saga,
      chain_seq: 2,
      actor: ACTOR,
      payload: {
        action: { kind: "http", name: "http.POST.api.example.com/v1/invoices", locality: "external" },
        tier: "T3",
        sources: [],
        reasons: ["fixture"],
        candidates: [],
        scope_violation: false,
      },
    },
    {
      v: "vekrevert/v1",
      id: evtId(3),
      type: "effect_opened",
      ts: ts(2),
      saga_id: saga,
      chain_seq: 3,
      effect_id: "eff_01FXTR0000000000000000001",
      actor: ACTOR,
      payload: {
        effect_id: "eff_01FXTR0000000000000000001",
        seq: 1,
        action: { kind: "http", name: "http.POST.api.example.com/v1/invoices", locality: "external" },
        tier: "T3",
        args_hash: "sha256:00",
        intent_key: "sha256:01",
      },
    },
    {
      v: "vekrevert/v1",
      id: evtId(4),
      type: "effect_closed",
      ts: ts(3),
      saga_id: saga,
      chain_seq: 4,
      effect_id: "eff_01FXTR0000000000000000001",
      actor: ACTOR,
      payload: {
        status: "landed",
        result_hash: "sha256:02",
        bindings: { invoice_id: "inv_1" },
        resource_keys: ["http:api.example.com/v1/invoices/inv_1"],
        duration_ms: 12,
        seal_hash: "sha256:03",
      },
    },
    {
      v: "vekrevert/v1",
      id: evtId(5),
      type: "receipt_issued",
      ts: ts(4),
      saga_id: saga,
      chain_seq: 5,
      effect_id: "eff_01FXTR0000000000000000001",
      actor: ACTOR,
      payload: { effect_id: "eff_01FXTR0000000000000000001", seal_hash: "sha256:03" },
    },
  ];

  for (const spec of specs) {
    const chained = chainEvent(
      { ...spec, prev_hash: prev, payload: spec.payload as unknown as JsonValue },
      prev,
    );
    events.push(chained as ReceiptEvent);
    prev = chained.hash;
  }
  return events;
}

export async function seedFixtureLedger(dir: string): Promise<{
  sagaId: string;
  sqlitePath: string;
  jsonlPath: string;
}> {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".vekrevert"), { recursive: true });
  const events = fixtureEvents();
  const jsonlPath = join(dir, "sag_fixture.jsonl");
  writeFileSync(jsonlPath, events.map((e) => canonicalize(e as unknown as JsonValue)).join("\n") + "\n");

  const sqlitePath = join(dir, ".vekrevert", "ledger.db");
  const ledger = await openLedger(`sqlite:${sqlitePath}`);
  for (const ev of events) await ledger.append(ev, { fsync: true });
  await ledger.close();

  return { sagaId: FIXTURE_SAGA_ID, sqlitePath, jsonlPath };
}
