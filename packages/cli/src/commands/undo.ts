/** vekrevert undo <saga-id> [--to-seq N] [--dry-run] [--continue-on-failure] [--json] */

import { VekRevertError } from "@latticeag/vekrevert-core";
import { VekRevert } from "@latticeag/vekrevert";
import type { Ledger } from "@latticeag/vekrevert";
import { mapVrExit } from "./execute.ts";

export async function undoCommand(argv: string[], ctx?: { ledger?: Ledger; vr?: VekRevert }): Promise<number> {
  let sagaId: string | undefined;
  let toSeq: number | undefined;
  let dryRun = false;
  let continueOnFailure = false;
  let json = false;
  let allowDrafted = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") dryRun = true;
    else if (a === "--continue-on-failure") continueOnFailure = true;
    else if (a === "--json") json = true;
    else if (a === "--allow-drafted") allowDrafted = true;
    else if (a === "--to-seq") toSeq = Number(argv[++i]);
    else if (a.startsWith("--to-seq=")) toSeq = Number(a.slice("--to-seq=".length));
    else if (a.startsWith("-")) {
      process.stderr.write(`unknown flag ${a}\n`);
      return 2;
    } else if (!sagaId) sagaId = a;
  }
  if (!sagaId) {
    process.stderr.write("usage: vekrevert undo <saga-id> [--to-seq N] [--dry-run] [--continue-on-failure] [--json]\n");
    return 2;
  }

  const vr =
    ctx?.vr ??
    new VekRevert({
      ledger: process.env.VEKREVERT_LEDGER ?? "sqlite:./.vekrevert/ledger.db",
    });
  if (ctx?.ledger) vr.ledgerHandle = ctx.ledger;
  else await vr.openLedgerHandle();

  try {
    const report = await vr.undo(sagaId, { toSeq, dryRun, continueOnFailure, allowDrafted });
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    else {
      process.stdout.write(
        `${report.saga_id} restored=${report.world_restored} compensated=${report.compensated} failed=${report.failed} escalated=${report.escalated}\n`,
      );
    }
    if (report.world_restored || (report.failed === 0 && report.escalated === 0)) return 0;
    return 5;
  } catch (err) {
    if (err instanceof VekRevertError && err.code === "VR5011") return mapVrExit(err);
    return mapVrExit(err);
  }
}
