/** vekrevert execute <plan-id> [--yes] [--dry-run] [--actor <id>] */

import { VekRevertError, type Actor } from "@latticeag/vekrevert-core";
import { VekRevert } from "@latticeag/vekrevert";
import type { Ledger } from "@latticeag/vekrevert";
import { loadWorkspaceConfig, ledgerUrlFromConfig } from "../config.ts";

export async function executeCommand(argv: string[], ctx?: { ledger?: Ledger; vr?: VekRevert }): Promise<number> {
  let planId: string | undefined;
  let yes = false;
  let dryRun = false;
  let actorId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--actor") actorId = argv[++i];
    else if (a.startsWith("--actor=")) actorId = a.slice("--actor=".length);
    else if (a.startsWith("-")) {
      process.stderr.write(`unknown flag ${a}\n`);
      return 2;
    } else if (!planId) planId = a;
  }
  if (!planId) {
    process.stderr.write("usage: vekrevert execute <plan-id> [--yes] [--dry-run] [--actor id]\n");
    return 2;
  }

  const cfg = loadWorkspaceConfig();
  const vr =
    ctx?.vr ??
    new VekRevert({
      ledger: process.env.VEKREVERT_LEDGER ?? ledgerUrlFromConfig(cfg),
      allowDrafted: cfg.allowDrafted,
      models: cfg.models,
      policy: cfg.policy,
      verification: cfg.verification,
      drafted: cfg.drafted,
      coordinatorUrl: cfg.coordinatorUrl,
    });
  if (ctx?.ledger) vr.ledgerHandle = ctx.ledger;
  else await vr.openLedgerHandle();

  try {
    const plan = await vr.ledgerHandle!.getPlan(planId);
    let compiled = plan;
    if (!compiled) {
      const p = await vr.plan(planId);
      if (p && "ok" in p && p.ok === false) {
        process.stderr.write(`${p.error_code} ${p.detail}\n`);
        return 3;
      }
      compiled = p as NonNullable<typeof plan>;
    }
    if (!compiled) {
      process.stderr.write("VR3001 unknown plan\n");
      return 3;
    }
    const needsYes = compiled.reversal_completeness !== "full";
    if (needsYes && !yes && !dryRun) {
      process.stderr.write("refusing: pass --yes when completeness is not full or tier is T4\n");
      return 2;
    }
    const actor: Actor | undefined = actorId ? { kind: "human", id: actorId } : undefined;
    const result = await vr.execute(compiled.plan_id, { actor, dryRun });
    process.stdout.write(`${result.ok ? "ok" : "failed"} ${result.plan_id} ${result.plan_hash}\n`);
    if (!result.ok) {
      const code = result.error_code ?? "VR5001";
      if (code.startsWith("VR5")) return 5;
      if (code.startsWith("VR6")) return 6;
      if (code.startsWith("VR4")) return 4;
      return 1;
    }
    return 0;
  } catch (err) {
    return mapVrExit(err);
  }
}

export function mapVrExit(err: unknown): number {
  if (err instanceof VekRevertError) {
    process.stderr.write(`${err.code} ${err.message}\n`);
    if (err.code.startsWith("VR5")) return 5;
    if (err.code.startsWith("VR6")) return 6;
    if (err.code.startsWith("VR4")) return 4;
    if (err.code.startsWith("VR3")) return 3;
    if (err.code.startsWith("VR2")) return 7;
    return 1;
  }
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}
