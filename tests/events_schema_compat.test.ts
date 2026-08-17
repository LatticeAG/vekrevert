import { describe, expect, it } from "vitest";
import {
  parseEvent,
  RESERVED_UMBRELLA_NAMES,
  VEKREVERT_EVENT_TYPES,
} from "@latticeag/vekrevert-events";

describe("events schema compatibility (D19)", () => {
  it("unknown types are ignored rather than rejected", () => {
    const parsed = parseEvent({
      v: "vekrevert/v1",
      id: "evt_01FXTR00000000000000000001",
      type: "totally_unknown_future_type",
      ts: "2026-08-17T15:00:00.000Z",
      saga_id: "sag_fixture",
      chain_seq: 1,
      actor: { kind: "system", id: "vekrevert" },
      payload: { extra: true },
      prev_hash: "sha256:00",
      hash: "sha256:01",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.known).toBe(false);
      expect(parsed.event.type).toBe("totally_unknown_future_type");
    }
  });

  it("reserved names are used verbatim", () => {
    const reserved = [
      "compensation_executed",
      "receipt_issued",
      "approval_granted",
      "reversibility_classified",
    ];
    for (const name of reserved) {
      expect(VEKREVERT_EVENT_TYPES, name).toContain(name);
      expect(name).toBe(name);
    }
    expect(RESERVED_UMBRELLA_NAMES).toContain("compensation_executed");
    expect(RESERVED_UMBRELLA_NAMES).toContain("receipt_issued");
    expect(RESERVED_UMBRELLA_NAMES).toContain("approval_granted");
    expect(RESERVED_UMBRELLA_NAMES).toContain("reversibility_classified");
    expect(VEKREVERT_EVENT_TYPES).toContain("compensation_executed");
    expect(VEKREVERT_EVENT_TYPES).toContain("receipt_issued");
    expect(VEKREVERT_EVENT_TYPES).toContain("approval_granted");
    expect(VEKREVERT_EVENT_TYPES).toContain("reversibility_classified");
  });

  it("known reserved events parse as known", () => {
    for (const type of ["compensation_executed", "receipt_issued", "approval_granted", "reversibility_classified"]) {
      const parsed = parseEvent({
        v: "vekrevert/v1",
        id: "evt_01FXTR00000000000000000002",
        type,
        ts: "2026-08-17T15:00:00.000Z",
        saga_id: "sag_fixture",
        chain_seq: 1,
        actor: { kind: "human", id: "op" },
        payload: {},
        prev_hash: "sha256:00",
        hash: "sha256:01",
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.known).toBe(true);
    }
  });
});
