/** Zod + JSON Schema export for vekrevert/v1 (D19). Standalone; no hard dep on @latticeag/events. */
import { z } from "zod";
import { VEKREVERT_EVENT_TYPES } from "./types.ts";

export const receiptEventSchema = z
  .object({
    v: z.literal("vekrevert/v1"),
    id: z.string().startsWith("evt_"),
    type: z.string(),
    ts: z.string(),
    saga_id: z.string(),
    chain_seq: z.number().int().positive(),
    effect_id: z.string().optional(),
    actor: z.object({
      kind: z.enum(["agent", "human", "system"]),
      id: z.string(),
    }),
    payload: z.record(z.unknown()),
    prev_hash: z.string(),
    hash: z.string(),
    sig: z.string().optional(),
  })
  .passthrough();

export function admitsNamespace(schemaVersion: string | undefined): boolean {
  if (!schemaVersion) return true;
  return schemaVersion.includes("vekrevert/v1") || schemaVersion.startsWith("latticeag/events");
}

export function isKnownType(type: string): boolean {
  return (VEKREVERT_EVENT_TYPES as string[]).includes(type);
}

/** Consumers must ignore unknown types rather than fail (D19). */
export function parseEvent(input: unknown): { ok: true; event: z.infer<typeof receiptEventSchema>; known: boolean } | { ok: false; error: string } {
  const parsed = receiptEventSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, event: parsed.data, known: isKnownType(parsed.data.type) };
}

export const jsonSchema = {
  $id: "https://latticeag.com/schemas/vekrevert/v1/receipt-event.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "vekrevert/v1 ReceiptEvent",
  type: "object",
  additionalProperties: true,
  required: ["v", "id", "type", "ts", "saga_id", "chain_seq", "actor", "payload", "prev_hash", "hash"],
  properties: {
    v: { const: "vekrevert/v1" },
    id: { type: "string" },
    type: { type: "string" },
    ts: { type: "string" },
    saga_id: { type: "string" },
    chain_seq: { type: "integer", minimum: 1 },
    effect_id: { type: "string" },
    actor: {
      type: "object",
      required: ["kind", "id"],
      properties: {
        kind: { enum: ["agent", "human", "system"] },
        id: { type: "string" },
      },
    },
    payload: { type: "object" },
    prev_hash: { type: "string" },
    hash: { type: "string" },
    sig: { type: "string" },
  },
};
