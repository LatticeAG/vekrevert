/** vekrevert verify <plan-id> [--json]  Exit 0 on PASS. Exit 4 on FAIL/UNSURE. */

import { VekRevertError } from "@latticeag/vekrevert-core";
import { VekRevert, verificationPassesGate } from "@latticeag/vekrevert";
import type { Ledger } from "@latticeag/vekrevert";
import { mapVrExit } from "./execute.ts";
import { loadWorkspaceConfig, ledgerUrlFromConfig } from "../config.ts";

export async function verifyCommand(argv: string[], ctx?: { ledger?: Ledger; vr?: VekRevert }): Promise<number> {
  let planId: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a.startsWith("-")) {
      process.stderr.write(`unknown flag ${a}\n`);
      return 2;
    } else if (!planId) planId = a;
  }
  if (!planId) {
    process.stderr.write("usage: vekrevert verify <plan-id> [--json]\n");
    return 2;
  }

  const cfg = loadWorkspaceConfig();
  const vr =
    ctx?.vr ??
    new VekRevert({
      ledger: ledgerUrlFromConfig(cfg),
      allowDrafted: cfg.allowDrafted,
      models: cfg.models,
      policy: cfg.policy,
      verification: cfg.verification,
    });
  if (ctx?.ledger) vr.ledgerHandle = ctx.ledger;
  else await vr.openLedgerHandle();

  try {
    const rec = await vr.verify(planId);
    if (json) process.stdout.write(JSON.stringify(rec, null, 2) + "\n");
    else {
      process.stdout.write(`${rec.verdict} ${rec.plan_hash} scope_ok=${rec.scope_ok} overreach=${rec.overreach}\n`);
    }
    if (verificationPassesGate(rec)) return 0;
    const code = rec.overreach ? "VR4004" : rec.verdict === "FAIL" ? "VR4001" : rec.verdict === "UNSURE" ? "VR4002" : "VR4002";
    process.stderr.write(`${code} verifier_${rec.verdict.toLowerCase()}\n`);
    return 4;
  } catch (err) {
    if (err instanceof VekRevertError && err.code === "VR3001") {
      process.stderr.write(`${err.code} ${err.detail ?? err.message}\n`);
      return 3;
    }
    return mapVrExit(err);
  }
}
