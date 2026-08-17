/** vekrevert bench classify|roundtrip|preflight (verifier is Phase 8). */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAction, type ActionSignature, type ClassifyContext, type JsonValue } from "@latticeag/vekrevert-core";
import { classifyCases } from "../../../../tests/fixtures/classify/cases.ts";

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

function runVitest(files: string[]): number {
  const root = repoRoot();
  const r = spawnSync("pnpm", ["exec", "vitest", "run", ...files], {
    cwd: root,
    stdio: "inherit",
    encoding: "utf8",
  });
  return r.status ?? 1;
}

export async function benchCommand(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === "verifier") {
    process.stderr.write("vekrevert bench verifier is Phase 8; not in v1\n");
    return 2;
  }
  if (sub === "classify") {
    const cases = classifyCases();
    let ok = 0;
    let fail = 0;
    for (const c of cases) {
      const ctx: ClassifyContext = { ...(c.ctx ?? {}) };
      if (c.ctx?.manifestTier) {
        ctx.manifest = {
          id: "cmp_test@1",
          match: { kind: "fs", op: "write", path_glob: c.ctx.manifestGlob ?? "/var/app/data/**" },
          tier: c.ctx.manifestTier,
          binds: {},
          compensator: { kind: "declarative", steps: [{ kind: "noop", reason: "t" }] },
          leak: "none",
          cascade_risk: "none",
          reversal_completeness: "full",
          source: "builtin",
        } as ActionSignature;
      }
      const rec = classifyAction(c.action, c.args, ctx);
      if (rec.tier === c.expected.tier) ok++;
      else {
        fail++;
        process.stderr.write(`${c.name}: got ${rec.tier} expected ${c.expected.tier}\n`);
      }
    }
    process.stdout.write(`classify ${ok}/${ok + fail} matched\n`);
    return fail === 0 ? 0 : 1;
  }
  if (sub === "roundtrip") {
    return runVitest([
      "tests/roundtrip_fs.test.ts",
      "tests/roundtrip_sql.test.ts",
      "tests/roundtrip_http.test.ts",
      "tests/roundtrip_message.test.ts",
    ]);
  }
  if (sub === "preflight") {
    return runVitest(["bench/preflight.bench.ts"]);
  }
  process.stderr.write("usage: vekrevert bench classify|roundtrip|preflight\n");
  return 2;
}
