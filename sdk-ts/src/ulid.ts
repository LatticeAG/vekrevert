/** Crockford ULID ids: sag_ / evt_ / cpl_ / att_ / esc_ + 26-char ULID. */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type UlidPrefix = "sag" | "evt" | "cpl" | "att" | "esc";

function encode(value: bigint, length: number): string {
  let out = "";
  let n = value;
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/** 26-character Crockford ULID (48-bit time + 80-bit entropy). */
export function crockfordUlid(nowMs: number = Date.now()): string {
  const time = encode(BigInt(nowMs), 10);
  const bytes = randomBytes(10);
  let entropy = 0n;
  for (const b of bytes) entropy = (entropy << 8n) | BigInt(b);
  return time + encode(entropy, 16);
}

export function ulid(prefix: UlidPrefix, nowMs?: number): string {
  return `${prefix}_${crockfordUlid(nowMs)}`;
}

export function newSagaId(nowMs?: number): string {
  return ulid("sag", nowMs);
}

export function newEventId(nowMs?: number): string {
  return ulid("evt", nowMs);
}

export function newPlanId(nowMs?: number): string {
  return ulid("cpl", nowMs);
}

export function newAttemptId(nowMs?: number): string {
  return ulid("att", nowMs);
}

export function newEscalationId(nowMs?: number): string {
  return ulid("esc", nowMs);
}
