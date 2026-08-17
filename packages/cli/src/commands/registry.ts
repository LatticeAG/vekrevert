/** vekrevert registry list [--json] | show <id> | verify [--strict] */

import { CompensatorRegistry } from "@latticeag/vekrevert/registry";

export async function registryCommand(argv: string[], ctx?: { ledger?: unknown }): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const registry = new CompensatorRegistry({ ledger: ctx?.ledger });
  await registry.hydrate();

  if (sub === "list") {
    const json = rest.includes("--json");
    const items = await registry.list();
    if (json) {
      process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    } else {
      for (const m of items) {
        process.stdout.write(`${m.id} ${m.source} ${m.match.kind} ${m.tier}\n`);
      }
    }
    return 0;
  }

  if (sub === "show") {
    const id = rest.find((a) => !a.startsWith("-"));
    if (!id) {
      process.stderr.write("usage: vekrevert registry show <id>\n");
      return 2;
    }
    const m = await registry.get(id);
    if (!m) {
      process.stderr.write(`VR3001 no_compensator_match: ${id}\n`);
      return 3;
    }
    process.stdout.write(JSON.stringify(m, null, 2) + "\n");
    return 0;
  }

  if (sub === "verify") {
    const strict = rest.includes("--strict");
    const result = await registry.verify({ strict });
    if (!result.ok) {
      process.stderr.write(`${result.error_code ?? "VR3005"} ${result.detail ?? "verify failed"}\n`);
      return result.error_code?.startsWith("VR4") ? 4 : 3;
    }
    process.stdout.write(`ok ${result.ids.length}\n`);
    return 0;
  }

  process.stderr.write("usage: vekrevert registry list [--json] | show <id> | verify [--strict]\n");
  return 2;
}
