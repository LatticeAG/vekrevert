/** vekrevert status <saga-id> [--json] */

import { VekRevert } from "@latticeag/vekrevert";
import type { Ledger } from "@latticeag/vekrevert";
import { mapVrExit } from "./execute.ts";

export async function statusCommand(argv: string[], ctx?: { ledger?: Ledger; vr?: VekRevert }): Promise<number> {
  let sagaId: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--watch") continue;
    else if (a.startsWith("-")) {
      process.stderr.write(`unknown flag ${a}\n`);
      return 2;
    } else if (!sagaId) sagaId = a;
  }
  if (!sagaId) {
    process.stderr.write("usage: vekrevert status <saga-id> [--json]\n");
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
    const st = await vr.status(sagaId);
    if (json) {
      process.stdout.write(
        JSON.stringify(
          {
            saga: st.saga,
            pending: st.pending,
            open_escalations: st.open_escalations,
            chain_head: st.chain_head,
            effects: st.effects.map((e) => ({
              seq: e.seq,
              action: e.action.name,
              tier: e.tier,
              status: e.status,
              compensation_state: e.compensation_state,
              leak: e.leak,
              cascade_risk: e.cascade_risk,
            })),
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(
        `${st.saga.saga_id} ${st.saga.status} pending=${st.pending} escalations=${st.open_escalations} head=${st.chain_head}\n`,
      );
      for (const e of st.effects) {
        process.stdout.write(`  ${e.seq} ${e.action.name} ${e.tier} ${e.status} ${e.compensation_state}\n`);
      }
    }
    return 0;
  } catch (err) {
    return mapVrExit(err);
  }
}
