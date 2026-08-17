/** vekrevert init [--ledger sqlite|jsonl|postgres] [--with-builtins] */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "@latticeag/vekrevert";
import { CompensatorRegistry } from "@latticeag/vekrevert/registry";
import { builtins } from "@latticeag/vekrevert-compensators";

function ledgerUrl(kind: string): string {
  if (kind === "jsonl") return "jsonl:./.vekrevert/events.jsonl";
  if (kind === "postgres") return "postgres://localhost:5432/vekrevert";
  return "sqlite:./.vekrevert/ledger.db";
}

export async function initCommand(argv: string[]): Promise<number> {
  let kind = "sqlite";
  let withBuiltins = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--ledger") kind = argv[++i] ?? "sqlite";
    else if (a.startsWith("--ledger=")) kind = a.slice("--ledger=".length);
    else if (a === "--with-builtins") withBuiltins = true;
    else if (a.startsWith("-")) {
      process.stderr.write(`unknown flag ${a}\n`);
      return 2;
    }
  }
  if (!["sqlite", "jsonl", "postgres"].includes(kind)) {
    process.stderr.write("usage: vekrevert init [--ledger sqlite|jsonl|postgres] [--with-builtins]\n");
    return 2;
  }

  const cwd = process.cwd();
  mkdirSync(join(cwd, ".vekrevert"), { recursive: true });
  const ledger = ledgerUrl(kind);
  const config = {
    ledger,
    agentId: "vekrevert",
    allowDrafted: false,
    recordT1: false,
    writableRoots: [] as string[],
    internalHosts: [] as string[],
    policy: { blockT4: false, requireApprovalFor: ["T4"] },
    models: { classifier: null, drafter: null, verifier: null },
    redact: {
      paths: ["$.password", "$.token", "$.authorization", "$.ssn"],
      patterns: ["sk_live_[A-Za-z0-9]+"],
    },
  };
  const configPath = join(cwd, "vekrevert.config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  } else {
    const existing = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if (existing.allowDrafted !== false && existing.allowDrafted !== undefined) {
      /* keep operator override */
    } else {
      existing.allowDrafted = false;
    }
    if (!existing.ledger) existing.ledger = ledger;
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
  }

  if (withBuiltins && kind !== "postgres") {
    const handle = await openLedger(ledger);
    try {
      const registry = new CompensatorRegistry({ ledger: handle });
      await registry.hydrate();
      await registry.register(builtins, { force: true });
    } finally {
      await handle.close();
    }
  }

  process.stdout.write(`initialized ledger=${ledger} allowDrafted=false\n`);
  return 0;
}
