/** Off-path S4 classifier. v1 default is disabled (D1). */
import type { ActionRef, JsonValue, Tier } from "@latticeag/vekrevert-core";

export async function classifyModel(
  _action: ActionRef,
  _args: JsonValue,
): Promise<{ tier: Tier; reasons: string[] } | null> {
  return null;
}
