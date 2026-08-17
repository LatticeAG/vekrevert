import { VekRevertError, type VekRevertConfig } from "@latticeag/vekrevert-core";
import type { ChainableEvent } from "@latticeag/vekrevert-core";
import type { ReceiptEvent } from "@latticeag/vekrevert-events";

export interface Ledger {
  readonly kind: "memory" | "jsonl" | "sqlite" | "postgres" | "http";
  append(ev: ReceiptEvent, opts?: { fsync?: boolean }): Promise<void>;
  readSaga(sagaId: string): Promise<ReceiptEvent[]>;
  close(): Promise<void>;
}

interface MemoryState {
  events: ReceiptEvent[];
}

export function openMemoryLedger(): Ledger {
  if (process.env.NODE_ENV === "production") {
    throw new VekRevertError("VR2001");
  }
  const state: MemoryState = { events: [] };
  return {
    kind: "memory",
    async append(ev) {
      state.events.push(ev);
    },
    async readSaga(sagaId) {
      return state.events.filter((e) => e.saga_id === sagaId);
    },
    async close() {},
  };
}

void 0 as unknown as ChainableEvent;
void 0 as unknown as VekRevertConfig;
