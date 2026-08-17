import { readFileSync } from "node:fs";
import { classifyAction, type ActionRef, type JsonValue } from "@latticeag/vekrevert-core";

export async function classifyCommand(argv: string[]): Promise<number> {
  const jsonFlag = argv.includes("--json");
  const file = argv.find((a) => !a.startsWith("-"));
  if (!file) {
    process.stderr.write("usage: vekrevert classify <action.json> [--json]\n");
    return 2;
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    action: ActionRef;
    args: JsonValue;
    ctx?: Record<string, unknown>;
    expected?: { tier: string };
  };
  const rec = classifyAction(raw.action, raw.args, (raw.ctx ?? {}) as never);
  if (jsonFlag) {
    process.stdout.write(JSON.stringify({ tier: rec.tier, sources: rec.sources, reasons: rec.reasons, candidates: rec.candidates, scope_violation: rec.scope_violation }, null, 2) + "\n");
  } else {
    process.stdout.write(`${rec.tier} ${rec.reasons.join(",")}\n`);
  }
  return 0;
}
