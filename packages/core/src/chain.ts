/** Per-saga hash chain. Identical math in the Python SDK (D7, D8). */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { canonicalize, sha256Hex, sha256Prefixed, crockford32 } from "./jcs.ts";
import type { JsonValue } from "./types.ts";

export const NS = "vekrevert/v1";

export function genesisHash(sagaId: string): string {
  return sha256Prefixed(`${NS}:${sagaId}`);
}

export function deriveEffectId(input: {
  saga_id: string;
  seq: number;
  action_name: string;
  args_hash: string;
}): string {
  const material = `${input.saga_id}|${input.seq}|${input.action_name}|${input.args_hash}`;
  const digest = createHash("sha256").update(material).digest();
  return `eff_${crockford32(digest).slice(0, 26)}`;
}

export function deriveIntentKey(actionName: string, strippedArgs: JsonValue): string {
  return sha256Prefixed(canonicalize({ action: actionName, args: strippedArgs }));
}

export function derivePlanHash(input: {
  effect_id: string;
  compensator_id: string;
  origin: string;
  steps: JsonValue;
}): string {
  return sha256Prefixed(
    canonicalize({
      effect_id: input.effect_id,
      compensator_id: input.compensator_id,
      origin: input.origin,
      steps: input.steps,
    }),
  );
}

export function deriveIdempotencyKey(input: {
  saga_id: string;
  effect_seq: number;
  compensator_id: string;
  plan_hash: string;
  step_index: number;
}): string {
  const material =
    "vekrevert.v1\n" +
    input.saga_id +
    "\n" +
    String(input.effect_seq) +
    "\n" +
    input.compensator_id +
    "\n" +
    input.plan_hash +
    "\n" +
    String(input.step_index);
  const digest = createHash("sha256").update(material).digest();
  return `vr1_${crockford32(digest).slice(0, 32)}`;
}

export function sealHash(receiptWithoutSeal: JsonValue): string {
  return sha256Prefixed(canonicalize(receiptWithoutSeal));
}

export interface ChainableEvent {
  v: "vekrevert/v1";
  id: string;
  type: string;
  ts: string;
  saga_id: string;
  chain_seq: number;
  effect_id?: string;
  actor: { kind: "agent" | "human" | "system"; id: string };
  payload: JsonValue;
  prev_hash: string;
  hash?: string;
  sig?: string;
}

export function eventBodyForHash(ev: Omit<ChainableEvent, "hash" | "sig"> | ChainableEvent): JsonValue {
  return {
    v: ev.v,
    id: ev.id,
    type: ev.type,
    ts: ev.ts,
    saga_id: ev.saga_id,
    chain_seq: ev.chain_seq,
    ...(ev.effect_id !== undefined ? { effect_id: ev.effect_id } : {}),
    actor: ev.actor,
    payload: ev.payload,
    prev_hash: ev.prev_hash,
  };
}

export function chainEvent<T extends Omit<ChainableEvent, "hash" | "sig">>(
  ev: T,
  prevHash: string,
): T & { prev_hash: string; hash: string } {
  const withPrev = { ...ev, prev_hash: prevHash };
  const hash = sha256Prefixed(canonicalize(eventBodyForHash(withPrev)));
  return { ...withPrev, hash };
}

export type ChainVerifyResult =
  | { ok: true }
  | {
      ok: false;
      brokenAt: number;
      reason: "hash_mismatch" | "prev_mismatch" | "seq_gap" | "bad_sig";
    };

export function verifyChain(
  events: ChainableEvent[],
  opts?: { publicKey?: Buffer | string; genesisSagaId?: string },
): ChainVerifyResult {
  if (events.length === 0) return { ok: true };
  const sagaId = opts?.genesisSagaId ?? events[0]!.saga_id;
  let expectedPrev = genesisHash(sagaId);
  let expectedSeq = 1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.chain_seq !== expectedSeq) {
      return { ok: false, brokenAt: i, reason: "seq_gap" };
    }
    if (ev.prev_hash !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: "prev_mismatch" };
    }
    const recomputed = sha256Prefixed(canonicalize(eventBodyForHash(ev)));
    if (recomputed !== ev.hash) {
      return { ok: false, brokenAt: i, reason: "hash_mismatch" };
    }
    if (ev.sig && opts?.publicKey) {
      const rawHex = (ev.hash ?? "").replace(/^sha256:/, "");
      const raw = Buffer.from(rawHex, "hex");
      const key =
        typeof opts.publicKey === "string"
          ? createPublicKey(opts.publicKey)
          : createPublicKey({ key: opts.publicKey, format: "der", type: "spki" });
      const ok = edVerify(null, raw, key, Buffer.from(ev.sig, "base64"));
      if (!ok) return { ok: false, brokenAt: i, reason: "bad_sig" };
    }
    expectedPrev = ev.hash ?? recomputed;
    expectedSeq += 1;
  }
  return { ok: true };
}

export function merkleRoot(pairs: Array<{ saga_id: string; chain_head: string }>): string {
  const sorted = [...pairs].sort((a, b) => (a.saga_id < b.saga_id ? -1 : a.saga_id > b.saga_id ? 1 : 0));
  const leaves = sorted.map((p) => sha256Hex(canonicalize({ saga_id: p.saga_id, chain_head: p.chain_head })));
  if (leaves.length === 0) return sha256Prefixed("");
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(sha256Hex(left + right));
    }
    level = next;
  }
  return `sha256:${level[0]!}`;
}

void sha256Hex;
