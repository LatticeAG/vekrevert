/** mcp_tool_call. Tool must be in permits. Id-shaped args are resolved receipt refs at compile time. */

import { VekRevertError, type CompensationStep, type JsonValue } from "@latticeag/vekrevert-core";
import type { StepContext, StepResult } from "../step.ts";

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, JsonValue>;
  return {};
}

function stringify(v: JsonValue | undefined): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

export async function executeMcp(step: CompensationStep, resolved: JsonValue, ctx: StepContext): Promise<StepResult> {
  if (step.kind !== "mcp_tool_call") throw new VekRevertError("VR5001", `expected mcp_tool_call, got ${step.kind}`);
  const rec = asRecord(resolved);
  const tool = stringify(rec.tool);
  const permits = ctx.permits ?? ctx.signature?.permits ?? [];
  if (!permits.includes(tool)) {
    throw new VekRevertError("VR3008", `mcp tool ${tool} not in permits`);
  }
  if (!ctx.mcpCall) throw new VekRevertError("VR5001", "mcp step requires ctx.mcpCall");
  const args = rec.args;
  const result = await ctx.mcpCall(tool, args ?? {});
  return { ok: true, kind: "mcp_tool_call", tool, result };
}
