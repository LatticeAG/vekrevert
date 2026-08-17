/** Pre-image blob store. Caps are hard: truncation is T4, never a partial restore (D9). */
import { DEFAULT_LIMITS, type PreimageRef } from "@latticeag/vekrevert-core";
import type { Ledger } from "../ledger/types.ts";

export interface PreimagePutInput {
  kind: PreimageRef["kind"];
  bytes?: Uint8Array;
  rows?: unknown[];
  meta?: Record<string, string | number>;
  maxBytes?: number;
  maxRows?: number;
}

function encodeRows(rows: unknown[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(rows));
}

/** Store a pre-image. Over-cap returns truncated:true and does not put a blob. */
export async function putPreimage(ledger: Ledger, input: PreimagePutInput): Promise<PreimageRef> {
  const maxBytes = input.maxBytes ?? DEFAULT_LIMITS.maxPreimageBytes;
  const maxRows = input.maxRows ?? DEFAULT_LIMITS.maxPreimageRows;

  if (input.kind === "fs_absent" || input.kind === "none") {
    return { kind: input.kind, truncated: false, ...(input.meta ? { meta: input.meta } : {}) };
  }

  if (input.kind === "sql_rows") {
    const rows = input.rows ?? [];
    const encoded = encodeRows(rows);
    if (rows.length > maxRows || encoded.byteLength > maxBytes) {
      return {
        kind: "sql_rows",
        rows: rows.length,
        bytes: encoded.byteLength,
        truncated: true,
        ...(input.meta ? { meta: input.meta } : {}),
      };
    }
    const blob_id = await ledger.putBlob(encoded);
    return {
      kind: "sql_rows",
      blob_id,
      rows: rows.length,
      bytes: encoded.byteLength,
      truncated: false,
      ...(input.meta ? { meta: input.meta } : {}),
    };
  }

  const bytes = input.bytes ?? new Uint8Array();
  if (bytes.byteLength > maxBytes) {
    return {
      kind: input.kind,
      bytes: bytes.byteLength,
      truncated: true,
      ...(input.meta ? { meta: input.meta } : {}),
    };
  }
  const blob_id = await ledger.putBlob(bytes);
  return {
    kind: input.kind,
    blob_id,
    bytes: bytes.byteLength,
    truncated: false,
    ...(input.meta ? { meta: input.meta } : {}),
  };
}
