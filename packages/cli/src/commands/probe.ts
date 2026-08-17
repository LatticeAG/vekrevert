/** vekrevert probe <effect-id> */

import { VekRevert } from "@latticeag/vekrevert";
import type { Ledger } from "@latticeag/vekrevert";
import { mapVrExit } from "./execute.ts";

export async function probeCommand(argv: string[], ctx?: { ledger?: Ledger; vr?: VekRevert }): Promise<number> {
  const effectId = argv.find((a) => !a.startsWith("-"));
  if (!effectId) {
    process.stderr.write("usage: vekrevert probe <effect-id>\n");
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
    const result = await vr.probe(effectId);
    process.stdout.write(`${result}\n`);
    if (result === "unknown") return 5;
    return 0;
  } catch (err) {
    return mapVrExit(err);
  }
}
