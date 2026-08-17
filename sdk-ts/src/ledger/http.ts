/** Hosted HTTP ledger stub. Chain is computed client-side before POST. Phase 9 owns the wire. */
import { chainEvent, genesisHash, VekRevertError, canonicalize, type JsonValue } from "@latticeag/vekrevert-core";
import type { ReceiptEvent } from "@latticeag/vekrevert-events";
import { createMemoryLedger, type Ledger, type LedgerOpenOptions } from "./types.ts";

function clientChain(event: ReceiptEvent, prior: ReceiptEvent[]): ReceiptEvent {
  const prev_hash = prior.length ? prior[prior.length - 1]!.hash : genesisHash(event.saga_id);
  const { hash: _ignored, sig: _sig, ...rest } = event;
  const chained = chainEvent(
    { ...rest, prev_hash, payload: rest.payload as unknown as JsonValue },
    prev_hash,
  );
  if (event.hash && event.hash !== chained.hash) {
    throw new VekRevertError("VR2015", "client hash does not match local chainEvent; refusing to send");
  }
  return chained as ReceiptEvent;
}

export function openHttpLedger(url: string, opts: LedgerOpenOptions = {}): Ledger {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const inner = createMemoryLedger(opts, [], {}, "http");

  return {
    ...inner,
    kind: "http",
    async append(event, appendOpts) {
      const prior = await inner.readSaga(event.saga_id);
      const hashed = clientChain(event, prior);
      if (!fetchFn) {
        throw new VekRevertError("VR2002", "http ledger has no fetch; refusing to send");
      }
      const body = canonicalize(hashed as unknown as JsonValue);
      let res: Response;
      try {
        res = await fetchFn(new URL("/events", url.endsWith("/") ? url : url + "/").toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
      } catch (err) {
        throw new VekRevertError("VR2002", `http ledger send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) {
        throw new VekRevertError("VR2002", `http ledger refused: ${res.status}`);
      }
      let remote: { hash?: string } | undefined;
      try {
        remote = (await res.json()) as { hash?: string };
      } catch {
        remote = undefined;
      }
      if (remote?.hash && remote.hash !== hashed.hash) {
        throw new VekRevertError("VR2015", "server returned a different hash; refusing forged history");
      }
      await inner.append(hashed, appendOpts);
    },
  };
}
