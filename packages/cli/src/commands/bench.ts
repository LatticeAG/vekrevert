/** vekrevert bench classify|verifier|roundtrip|preflight */

import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyAction,
  compilePlan,
  isPlanRejection,
  type ActionSignature,
  type ClassifyContext,
  type CompensationPlan,
  type CompensationStep,
  type EffectReceipt,
  type JsonValue,
} from "@latticeag/vekrevert-core";
import { classifyCases } from "../../../../tests/fixtures/classify/cases.ts";
import {
  draftCompileVerify,
  draftedSignature,
  verifyPlan,
  verificationPassesGate,
} from "@latticeag/vekrevert";

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
    let corpus = join(repoRoot(), "bench", "verifier_redteam");
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--corpus") corpus = argv[++i] ?? corpus;
      else if (argv[i]?.startsWith("--corpus=")) corpus = argv[i]!.slice("--corpus=".length);
    }
    return benchVerifier(corpus);
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
  process.stderr.write("usage: vekrevert bench classify|verifier|roundtrip|preflight [--corpus <dir>]\n");
  return 2;
}

interface RedTeamCase {
  name?: string;
  class?: string;
  receipt: EffectReceipt;
  plan: { steps: CompensationStep[] };
  must_reject_with: string;
}

async function benchVerifier(corpusDir: string): Promise<number> {
  const files = readdirSync(corpusDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    process.stderr.write(`no corpus json in ${corpusDir}\n`);
    return 2;
  }

  let compileRejected = 0;
  let verifierRejected = 0;
  let falsePass = 0;
  let other = 0;
  const falsePassNames: string[] = [];

  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(corpusDir, file), "utf8")) as RedTeamCase;
    const receipt = raw.receipt;
    const steps = raw.plan.steps;
    const sig = draftedSignature(receipt, steps);
    const compiled = compilePlan(receipt, sig, { origin: "drafted", steps, plan_id: `cpl_rt_${file}` });
    if (isPlanRejection(compiled)) {
      compileRejected += 1;
      continue;
    }
    const rec = await verifyPlan(compiled, receipt, { signature: sig });
    if (verificationPassesGate(rec)) {
      falsePass += 1;
      falsePassNames.push(file);
    } else {
      verifierRejected += 1;
    }
  }

  const total = files.length;
  const recall = total === 0 ? 0 : compileRejected / total;
  const coverage = await reportDraftedCoverage();

  process.stdout.write(
    [
      `cases ${total}`,
      `compile_rejection_recall ${(recall * 100).toFixed(1)}%`,
      `verifier_false_pass ${falsePass}`,
      `verifier_rejected ${verifierRejected}`,
      `other ${other}`,
      `drafted_coverage ${coverage.toFixed(1)}%`,
    ].join("\n") + "\n",
  );
  if (falsePassNames.length) {
    process.stderr.write(`false PASS: ${falsePassNames.join(", ")}\n`);
  }
  if (falsePass > 0 || recall < 0.85) return 1;
  return 0;
}

async function reportDraftedCoverage(): Promise<number> {
  const cases = coverageReceipts();
  let pass = 0;
  for (const receipt of cases) {
    const piped = await draftCompileVerify(receipt);
    if ("plan" in piped) pass += 1;
  }
  return cases.length === 0 ? 0 : (pass / cases.length) * 100;
}

function coverageReceipts(): EffectReceipt[] {
  const base = (over: Partial<EffectReceipt> & { action: EffectReceipt["action"] }): EffectReceipt => ({
    v: "vekrevert/v1",
    effect_id: over.effect_id ?? "eff_cov",
    saga_id: over.saga_id ?? "sag_cov",
    seq: 1,
    action: over.action,
    tier: over.tier ?? "T3",
    classification: { tier: over.tier ?? "T3", sources: [], reasons: [], candidates: [], scope_violation: false },
    args_observed: over.args_observed ?? {},
    args_hash: "sha256:cov",
    intent_key: "sha256:cov",
    result_observed: over.result_observed,
    bindings: over.bindings ?? {},
    binding_paths: {},
    resource_keys: over.resource_keys ?? [],
    status: "landed",
    compensation_state: "available",
    capture: { fidelity: "full", interceptor: "bench", sdk_version: "0.1.0", warnings: [] },
    leak: "none",
    cascade_risk: "none",
    opened_at: "1970-01-01T00:00:00.000Z",
    redactions: [],
    sealed: true,
    preimage: over.preimage,
  });
  return [
    base({
      effect_id: "eff_cov_http",
      action: { kind: "http", name: "http.POST.api.example.com/v1/widgets", target: "api.example.com", locality: "external" },
      args_observed: { method: "POST", url: "https://api.example.com/v1/widgets", body: { n: 1 } },
      result_observed: { status: 201, id: "w_1" },
      bindings: { resource_url: "https://api.example.com/v1/widgets/w_1", id: "w_1" },
      resource_keys: ["http:api.example.com:/v1/widgets/w_1"],
    }),
    base({
      effect_id: "eff_cov_sql",
      action: { kind: "sql", name: "sql.INSERT.postgres.widgets", target: "app", locality: "internal" },
      tier: "T2",
      args_observed: { statement: "INSERT", table: "widgets", values: { name: "a" } },
      result_observed: { rowcount: 1 },
      bindings: { id: "7" },
      resource_keys: ["sql:postgres:app:widgets:id=7"],
    }),
    base({
      effect_id: "eff_cov_fs",
      action: { kind: "fs", name: "fs.write", target: "/var/app/data/a.txt", locality: "internal" },
      tier: "T2",
      args_observed: { op: "write", path: "/var/app/data/a.txt" },
      bindings: {},
      resource_keys: ["fs:/var/app/data/a.txt"],
      preimage: { kind: "fs_bytes", blob_id: "blob_1", bytes: 4, truncated: false },
    }),
    base({
      effect_id: "eff_cov_http2",
      action: { kind: "http", name: "http.POST.api.acme.test/v2/jobs", locality: "external" },
      args_observed: { method: "POST", url: "https://api.acme.test/v2/jobs" },
      result_observed: { status: 201, id: "job_9" },
      bindings: { resource_url: "https://api.acme.test/v2/jobs/job_9", id: "job_9" },
      resource_keys: ["http:api.acme.test:/v2/jobs/job_9"],
    }),
    base({
      effect_id: "eff_cov_sql2",
      action: { kind: "sql", name: "sql.INSERT.sqlite.notes", target: "app", locality: "internal" },
      tier: "T2",
      args_observed: { statement: "INSERT", table: "notes" },
      result_observed: { changes: 1 },
      bindings: { id: "n1" },
      resource_keys: ["sql:sqlite:app:notes:id=n1"],
    }),
  ];
}

void 0 as unknown as CompensationPlan;
void 0 as unknown as JsonValue;
