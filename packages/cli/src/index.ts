/** vekrevert CLI dispatcher. */

import { openLedger } from "@latticeag/vekrevert";
import { classifyCommand } from "./commands/classify.ts";
import { receiptsCommand } from "./commands/receipts.ts";
import { replayCommand } from "./commands/replay.ts";
import { registerCommand } from "./commands/register.ts";
import { registryCommand } from "./commands/registry.ts";
import { planCommand } from "./commands/plan.ts";
import { executeCommand } from "./commands/execute.ts";
import { undoCommand } from "./commands/undo.ts";
import { statusCommand } from "./commands/status.ts";
import { probeCommand } from "./commands/probe.ts";
import { initCommand } from "./commands/init.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { escalateCommand, escalationsCommand } from "./commands/escalate.ts";
import { benchCommand } from "./commands/bench.ts";
import { loadWorkspaceConfig, ledgerUrlFromConfig } from "./config.ts";

const USAGE = `vekrevert - compensating transactions for agent side effects

Usage:
  vekrevert <command> [args]
`;

export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE);
    return cmd ? 0 : 2;
  }
  if (cmd === "classify") return classifyCommand(argv.slice(1));
  if (cmd === "init") return initCommand(argv.slice(1));
  if (cmd === "doctor") return doctorCommand(argv.slice(1));
  if (cmd === "bench") return benchCommand(argv.slice(1));

  if (cmd === "register") {
    const dry = argv.includes("--dry-run");
    if (dry) return registerCommand(argv.slice(1));
    const cfg = loadWorkspaceConfig();
    const ledgerUrl = ledgerUrlFromConfig(cfg);
    const ledger = await openLedger(ledgerUrl);
    try {
      return await registerCommand(argv.slice(1), { ledger });
    } finally {
      await ledger.close();
    }
  }

  if (cmd === "plan") {
    const rest = argv.slice(1);
    const needsLedger = !rest.includes("--action-json") && !rest.some((a) => a.startsWith("--action-json="));
    if (!needsLedger) return planCommand(rest);
    const cfg = loadWorkspaceConfig();
    const ledgerUrl = ledgerUrlFromConfig(cfg);
    const ledger = await openLedger(ledgerUrl);
    try {
      return await planCommand(rest, { ledger });
    } finally {
      await ledger.close();
    }
  }

  const cfg = loadWorkspaceConfig();
  const ledgerUrl = ledgerUrlFromConfig(cfg);
  if (
    cmd === "receipts" ||
    cmd === "replay" ||
    cmd === "registry" ||
    cmd === "execute" ||
    cmd === "undo" ||
    cmd === "status" ||
    cmd === "probe" ||
    cmd === "escalate" ||
    cmd === "escalations"
  ) {
    const ledger = await openLedger(ledgerUrl);
    const ctx = { ledger, stdout: process.stdout, stderr: process.stderr };
    try {
      if (cmd === "receipts") return await receiptsCommand(argv.slice(1), ctx);
      if (cmd === "registry") return await registryCommand(argv.slice(1), { ledger });
      if (cmd === "execute") return await executeCommand(argv.slice(1), { ledger });
      if (cmd === "undo") return await undoCommand(argv.slice(1), { ledger });
      if (cmd === "status") return await statusCommand(argv.slice(1), { ledger });
      if (cmd === "probe") return await probeCommand(argv.slice(1), { ledger });
      if (cmd === "escalate") return await escalateCommand(argv.slice(1), { ledger });
      if (cmd === "escalations") return await escalationsCommand(argv.slice(1), { ledger });
      return await replayCommand(argv.slice(1), ctx);
    } finally {
      await ledger.close();
    }
  }

  process.stderr.write(`vekrevert: unknown command '${cmd}' (not_implemented)\n`);
  return 2;
}
