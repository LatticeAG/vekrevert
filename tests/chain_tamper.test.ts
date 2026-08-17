import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { chainEvent, genesisHash, verifyChain, VekRevertError, type ChainableEvent, type JsonValue } from "@latticeag/vekrevert-core";
import type { ReceiptEvent } from "@latticeag/vekrevert-events";
import { openLedger } from "../sdk-ts/src/ledger/open.ts";
import { receiptsCommand } from "../packages/cli/src/commands/receipts.ts";
import { replayCommand } from "../packages/cli/src/commands/replay.ts";
import { seedFixtureLedger, fixtureEvents, FIXTURE_SAGA_ID } from "./fixtures/ledger/seed.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "vr-ledger-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const ACTOR = { kind: "system" as const, id: "vekrevert" };

function chainedEvents(sagaId: string, n: number, typeFor: (seq: number) => ReceiptEvent["type"] = (seq) => (seq === 1 ? "saga_opened" : "effect_opened")): ReceiptEvent[] {
  const out: ReceiptEvent[] = [];
  let prev = genesisHash(sagaId);
  const t0 = Date.parse("2026-08-17T12:00:00.000Z");
  for (let seq = 1; seq <= n; seq++) {
    const type = typeFor(seq);
    const payload =
      type === "saga_opened"
        ? { sdk_version: "0.1.0" }
        : type === "effect_opened"
          ? {
              effect_id: `eff_${String(seq).padStart(26, "0")}`,
              seq,
              action: { kind: "http", name: "http.POST.example/x", locality: "external" },
              tier: "T3",
              args_hash: "sha256:aa",
              intent_key: "sha256:bb",
            }
          : { n: seq };
    const body = {
      v: "vekrevert/v1" as const,
      id: `evt_${String(seq).padStart(26, "0")}`,
      type,
      ts: new Date(t0 + seq * 1000).toISOString(),
      saga_id: sagaId,
      chain_seq: seq,
      ...(type === "effect_opened" ? { effect_id: `eff_${String(seq).padStart(26, "0")}` } : {}),
      actor: ACTOR,
      payload,
      prev_hash: prev,
    };
    const chained = chainEvent({ ...body, payload: payload as unknown as JsonValue } as Omit<ChainableEvent, "hash" | "sig">, prev);
    out.push(chained as ReceiptEvent);
    prev = chained.hash;
  }
  return out;
}

describe("chain tamper", () => {
  it("50 events, tamper a byte of event 17, verifyChain reports hash_mismatch", async () => {
    const dir = tmp();
    const path = join(dir, "events.jsonl");
    const saga = "sag_tamper50";
    const events = chainedEvents(saga, 50);
    const ledger = await openLedger(`jsonl:${path}`);
    for (const ev of events) await ledger.append(ev);
    await ledger.close();

    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(50);
    const ev17 = JSON.parse(lines[16]!) as ReceiptEvent;
    ev17.payload = { ...(ev17.payload as object), tampered: true } as ReceiptEvent["payload"];
    lines[16] = JSON.stringify(ev17);
    writeFileSync(path, lines.join("\n") + "\n");

    const reopened = await openLedger(`jsonl:${path}`);
    const loaded = await reopened.readSaga(saga);
    await reopened.close();
    const result = verifyChain(loaded as unknown as ChainableEvent[]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("hash_mismatch");
      expect(result.brokenAt).toBe(16);
    }

    const stderr: string[] = [];
    const code = await receiptsCommand(["sag_tamper50", "--verify-chain"], {
      ledger: await openLedger(`jsonl:${path}`),
      stdout: { write: () => {} },
      stderr: { write: (c) => void stderr.push(c) },
    });
    expect(code).toBe(7);
    expect(stderr.join("")).toContain("VR2015");
  });

  it("seq gap is reported", () => {
    const events = chainedEvents("sag_gap", 5);
    events[2] = { ...events[2]!, chain_seq: 9 };
    const result = verifyChain(events as unknown as ChainableEvent[]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("seq_gap");
  });

  it("prev_hash mismatch is reported", () => {
    const events = chainedEvents("sag_prev", 5);
    events[3] = { ...events[3]!, prev_hash: genesisHash("other") };
    const result = verifyChain(events as unknown as ChainableEvent[]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("prev_mismatch");
  });

  it("UPDATE and DELETE on receipt_events raise VR2015 via sqlite trigger", async () => {
    const dir = tmp();
    const dbPath = join(dir, "ledger.db");
    const ledger = await openLedger(`sqlite:${dbPath}`);
    for (const ev of chainedEvents("sag_imm", 3)) await ledger.append(ev);
    await ledger.close();

    const db = new DatabaseSync(dbPath);
    expect(() => db.exec("UPDATE receipt_events SET type = type")).toThrow(/VR2015/);
    expect(() => db.exec("DELETE FROM receipt_events")).toThrow(/VR2015/);
    db.close();
  });

  it("anchor fires every 256 events and at 60s with an injectable clock", async () => {
    let now = Date.parse("2026-08-17T12:00:00.000Z");
    const clock = () => new Date(now);
    const dir = tmp();
    const ledger = await openLedger(`sqlite:${join(dir, "a.db")}`, {
      clock,
      anchorEvery: 256,
      anchorIntervalMs: 60_000,
    });
    const saga = "sag_anchor";
    const batch = chainedEvents(saga, 256);
    for (const ev of batch) await ledger.append(ev);
    const all = await ledger.readAll();
    const anchored = all.filter((e) => e.type === "ledger_anchored");
    expect(anchored.length).toBeGreaterThanOrEqual(1);
    await ledger.close();

    let now2 = Date.parse("2026-08-17T12:00:00.000Z");
    const clock2 = () => new Date(now2);
    const ledger2 = await openLedger(`sqlite:${join(dir, "b.db")}`, {
      clock: clock2,
      anchorEvery: 256,
      anchorIntervalMs: 60_000,
    });
    for (const ev of chainedEvents("sag_tock", 2)) await ledger2.append(ev);
    now2 += 60_000;
    const fired = await ledger2.maybeTickAnchor();
    expect(fired).toBe(true);
    const all2 = await ledger2.readAll();
    expect(all2.some((e) => e.type === "ledger_anchored")).toBe(true);
    await ledger2.close();
  });

  it("seeded sag_fixture verifies and replay is clean", async () => {
    const dir = tmp();
    const seeded = await seedFixtureLedger(dir);
    const ledger = await openLedger(`sqlite:${seeded.sqlitePath}`);
    const events = await ledger.readSaga(FIXTURE_SAGA_ID);
    expect(events.length).toBe(fixtureEvents().length);
    expect(verifyChain(events as unknown as ChainableEvent[])).toEqual({ ok: true });
    const code = await receiptsCommand([FIXTURE_SAGA_ID, "--verify-chain"], {
      ledger,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    expect(code).toBe(0);
    const replay1 = await replayCommand([FIXTURE_SAGA_ID], {
      ledger,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    expect(replay1).toBe(0);

    const db = new DatabaseSync(seeded.sqlitePath);
    db.exec("DELETE FROM effects");
    db.close();
    const replay2 = await replayCommand([FIXTURE_SAGA_ID], {
      ledger,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    expect(replay2).toBe(7);
    const replay3 = await replayCommand([FIXTURE_SAGA_ID], {
      ledger,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    expect(replay3).toBe(0);
    await ledger.close();
  });
});

void VekRevertError;
