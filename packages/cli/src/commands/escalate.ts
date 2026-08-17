/** vekrevert escalate <effect-id> --reason <code>
 *  vekrevert escalations list|show
 */

import { VekRevert } from "@latticeag/vekrevert";
import { listStoredEscalations, getStoredEscalation } from "@latticeag/vekrevert";
import type { EscalationReasonCode } from "@latticeag/vekrevert-core";
import type { Ledger } from "@latticeag/vekrevert";
import { mapVrExit } from "./execute.ts";
import { loadWorkspaceConfig, ledgerUrlFromConfig } from "../config.ts";

const REASONS = new Set<EscalationReasonCode>([
  "t4_irreversible",
  "verifier_rejected",
  "compile_rejected",
  "compensation_failed",
  "unresolved_in_doubt",
  "lease_unavailable",
  "window_expired",
  "cascade_risk",
  "drafted_not_allowed",
]);

export async function escalateCommand(argv: string[], ctx?: { ledger?: Ledger; vr?: VekRevert }): Promise<number> {
  let effectId: string | undefined;
  let reason: string | undefined;
  let priority: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--reason") reason = argv[++i];
    else if (a.startsWith("--reason=")) reason = a.slice("--reason=".length);
    else if (a === "--priority") priority = argv[++i];
    else if (a.startsWith("--priority=")) priority = a.slice("--priority=".length);
    else if (a.startsWith("-")) {
      process.stderr.write(`unknown flag ${a}\n`);
      return 2;
    } else if (!effectId) effectId = a;
  }
  if (!effectId || !reason) {
    process.stderr.write("usage: vekrevert escalate <effect-id> --reason <code>\n");
    return 2;
  }
  if (!REASONS.has(reason as EscalationReasonCode)) {
    process.stderr.write(`unknown reason ${reason}\n`);
    return 2;
  }
  void priority;
  const cfg = loadWorkspaceConfig();
  const vr =
    ctx?.vr ??
    new VekRevert({
      ledger: ledgerUrlFromConfig(cfg),
      allowDrafted: false,
      policy: cfg.policy,
      escalation: cfg.escalation,
    });
  if (ctx?.ledger) vr.ledgerHandle = ctx.ledger;
  else await vr.openLedgerHandle();
  try {
    const esc = await vr.escalate(effectId, reason as EscalationReasonCode);
    process.stdout.write(`${esc.escalation_id} ${esc.reason_code} ${esc.status}\n`);
    return 6;
  } catch (err) {
    return mapVrExit(err);
  }
}

export async function escalationsCommand(argv: string[], ctx?: { ledger?: Ledger }): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "list") {
    const want = rest.includes("--status") ? rest[rest.indexOf("--status") + 1] : undefined;
    const items = listStoredEscalations().filter((e) => !want || want === "pending");
    if (ctx?.ledger) {
      const all = await ctx.ledger.readAll();
      const raised = all.filter((e) => e.type === "escalation_raised");
      for (const ev of raised) {
        const p = ev.payload as Record<string, unknown>;
        process.stdout.write(`${p.escalation_id ?? ev.id} ${p.reason_code} ${ev.saga_id}\n`);
      }
      if (raised.length === 0 && items.length === 0) process.stdout.write("(none)\n");
    } else {
      for (const e of items) process.stdout.write(`${e.escalation_id} ${e.payload.reason_code} ${e.saga_id}\n`);
      if (items.length === 0) process.stdout.write("(none)\n");
    }
    return 0;
  }
  if (sub === "show") {
    const id = rest.find((a) => !a.startsWith("-"));
    if (!id) {
      process.stderr.write("usage: vekrevert escalations show <id>\n");
      return 2;
    }
    const found = getStoredEscalation(id);
    if (!found) {
      process.stderr.write(`unknown escalation ${id}\n`);
      return 1;
    }
    process.stdout.write(JSON.stringify(found.payload, null, 2) + "\n");
    return 0;
  }
  process.stderr.write("usage: vekrevert escalations list|show <id>\n");
  return 2;
}
