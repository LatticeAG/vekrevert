/** vekrevert receipts <saga-id> [--verify-chain] [--out file] [--since ts] */
import { writeFileSync } from "node:fs";
import {
  canonicalize,
  verifyChain,
  VekRevertError,
  type ChainableEvent,
  type JsonValue,
} from "@latticeag/vekrevert-core";
import type { ReceiptEvent } from "@latticeag/vekrevert-events";

export interface CommandContext {
  ledger: {
    readSaga(sagaId: string): Promise<ReceiptEvent[]>;
    rebuildProjections(
      sagaId: string,
      opts?: { asOf?: string },
    ): Promise<Array<{ entity: string; id: string; field: string }>>;
  };
  stdout?: { write(chunk: string): void };
  stderr?: { write(chunk: string): void };
  writeFile?: (path: string, data: string) => void;
}

export interface ReceiptsArgs {
  sagaId: string;
  verifyChain?: boolean;
  out?: string;
  since?: string;
}

export function parseReceiptsArgs(argv: string[]): ReceiptsArgs | { error: string } {
  let sagaId: string | undefined;
  let verify = false;
  let out: string | undefined;
  let since: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--verify-chain") verify = true;
    else if (a === "--out") out = argv[++i];
    else if (a.startsWith("--out=")) out = a.slice("--out=".length);
    else if (a === "--since") since = argv[++i];
    else if (a.startsWith("--since=")) since = a.slice("--since=".length);
    else if (a.startsWith("-")) return { error: `unknown flag ${a}` };
    else if (!sagaId) sagaId = a;
    else return { error: `unexpected argument ${a}` };
  }
  if (!sagaId) return { error: "usage: vekrevert receipts <saga-id> [--verify-chain] [--out file] [--since ts]" };
  return { sagaId, verifyChain: verify, out, since };
}

function isStructured(args: string[] | ReceiptsArgs): args is ReceiptsArgs {
  return !Array.isArray(args);
}

export async function receiptsCommand(args: string[] | ReceiptsArgs, ctx: CommandContext): Promise<number> {
  const stdout = ctx.stdout ?? process.stdout;
  const stderr = ctx.stderr ?? process.stderr;
  const parsed = isStructured(args) ? args : parseReceiptsArgs(args);
  if ("error" in parsed) {
    stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const events = await ctx.ledger.readSaga(parsed.sagaId);
  const exported = parsed.since ? events.filter((e) => e.ts >= parsed.since!) : events;
  const text = exported.map((e) => canonicalize(e as unknown as JsonValue)).join("\n") + (exported.length ? "\n" : "");
  if (parsed.out) {
    const write = ctx.writeFile ?? ((p: string, d: string) => writeFileSync(p, d));
    write(parsed.out, text);
  } else {
    stdout.write(text);
  }
  if (parsed.verifyChain) {
    const result = verifyChain(events as unknown as ChainableEvent[]);
    if (!result.ok) {
      stderr.write(
        `VR2015 chain_broken: brokenAt=${result.brokenAt} reason=${result.reason}\n`,
      );
      return 7;
    }
  }
  return 0;
}

void VekRevertError;
