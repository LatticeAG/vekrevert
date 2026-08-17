/** vekrevert replay <saga-id> [--as-of ts] */
import { VekRevertError } from "@latticeag/vekrevert-core";
import type { CommandContext } from "./receipts.ts";

export interface ReplayArgs {
  sagaId: string;
  asOf?: string;
}

export function parseReplayArgs(argv: string[]): ReplayArgs | { error: string } {
  let sagaId: string | undefined;
  let asOf: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--as-of") asOf = argv[++i];
    else if (a.startsWith("--as-of=")) asOf = a.slice("--as-of=".length);
    else if (a.startsWith("-")) return { error: `unknown flag ${a}` };
    else if (!sagaId) sagaId = a;
    else return { error: `unexpected argument ${a}` };
  }
  if (!sagaId) return { error: "usage: vekrevert replay <saga-id> [--as-of ts]" };
  return { sagaId, asOf };
}

function isStructured(args: string[] | ReplayArgs): args is ReplayArgs {
  return !Array.isArray(args);
}

export async function replayCommand(args: string[] | ReplayArgs, ctx: CommandContext): Promise<number> {
  const stdout = ctx.stdout ?? process.stdout;
  const stderr = ctx.stderr ?? process.stderr;
  const parsed = isStructured(args) ? args : parseReplayArgs(args);
  if ("error" in parsed) {
    stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const divergences = await ctx.ledger.rebuildProjections(parsed.sagaId, { asOf: parsed.asOf });
  if (divergences.length > 0) {
    stderr.write(`VR2022 projection_divergence: ${divergences.length} field(s)\n`);
    for (const d of divergences) {
      stderr.write(`  ${d.entity} ${d.id} ${d.field}\n`);
    }
    return 7;
  }
  stdout.write(`replay ${parsed.sagaId}: projections match\n`);
  return 0;
}

void VekRevertError;
