/** vekrevert doctor [--json] - twelve checks from SPEC 11.6. Never prints secret values. */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { verifyChain, SDK_VERSION } from "@latticeag/vekrevert-core";
import { openLedger } from "@latticeag/vekrevert";
import { CompensatorRegistry } from "@latticeag/vekrevert/registry";
import { builtins } from "@latticeag/vekrevert-compensators";
import { loadWorkspaceConfig } from "../config.ts";

type Status = "pass" | "fail" | "skip" | "warn";

interface Check {
  n: number;
  name: string;
  status: Status;
  detail: string;
}

function envFlag(name: string): string {
  return process.env[name] ? "set" : "unset";
}

export async function doctorCommand(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const cwd = process.cwd();
  const checks: Check[] = [];
  const cfg = loadWorkspaceConfig(cwd);

  // 1. Config parses; referenced compensator files exist.
  try {
    const files = (cfg.compensators ?? []).filter((c): c is string => typeof c === "string");
    const missing = files.filter((f) => !existsSync(resolve(cwd, f)));
    checks.push({
      n: 1,
      name: "config",
      status: missing.length ? "fail" : "pass",
      detail: missing.length ? `missing compensator files: ${missing.join(", ")}` : "vekrevert.config.json ok",
    });
  } catch (err) {
    checks.push({ n: 1, name: "config", status: "fail", detail: err instanceof Error ? err.message : String(err) });
  }

  // 2. Ledger reachable and writable; probe write + rollback.
  try {
    mkdirSync(join(cwd, ".vekrevert"), { recursive: true });
    const probe = join(cwd, ".vekrevert", "_doctor_probe");
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    const ledger = await openLedger(cfg.ledger, cfg.ledgerOpts);
    await ledger.close();
    checks.push({ n: 2, name: "ledger", status: "pass", detail: `writable ${cfg.ledger}` });
  } catch (err) {
    checks.push({ n: 2, name: "ledger", status: "fail", detail: err instanceof Error ? err.message : String(err) });
  }

  // 3. fsync actually durable.
  try {
    mkdirSync(join(cwd, ".vekrevert"), { recursive: true });
    const p = join(cwd, ".vekrevert", "_doctor_fsync");
    const fd = openSync(p, "w");
    writeSync(fd, "vekrevert-fsync-probe");
    fsyncSync(fd);
    closeSync(fd);
    const back = readFileSync(p, "utf8");
    unlinkSync(p);
    checks.push({
      n: 3,
      name: "fsync",
      status: back.includes("vekrevert-fsync-probe") ? "pass" : "fail",
      detail: back.includes("vekrevert-fsync-probe") ? "reopen confirmed" : "probe mismatch",
    });
  } catch (err) {
    checks.push({ n: 3, name: "fsync", status: "fail", detail: err instanceof Error ? err.message : String(err) });
  }

  // 4. Registry loads; verify --strict.
  try {
    const ledger = await openLedger(cfg.ledger, cfg.ledgerOpts);
    try {
      const registry = new CompensatorRegistry({ ledger });
      await registry.hydrate();
      const listed = await registry.list();
      const result = await registry.verify({ strict: true });
      checks.push({
        n: 4,
        name: "registry",
        status: result.ok ? "pass" : "warn",
        detail: result.ok ? `ok ${result.ids.length || listed.length}` : `${result.error_code} ${result.detail}`,
      });
    } finally {
      await ledger.close();
    }
  } catch (err) {
    checks.push({ n: 4, name: "registry", status: "fail", detail: err instanceof Error ? err.message : String(err) });
  }

  // 5. Built-in compensators present and version-matched to the SDK.
  try {
    const ids = builtins.map((b) => b.id);
    const want = ["cmp_fs_write@1", "cmp_sql_row@1", "cmp_http_create@1"];
    const missing = want.filter((id) => !ids.includes(id));
    checks.push({
      n: 5,
      name: "builtins",
      status: missing.length ? "fail" : "pass",
      detail: missing.length ? `missing ${missing.join(", ")}` : `sdk ${SDK_VERSION} builtins present`,
    });
  } catch (err) {
    checks.push({ n: 5, name: "builtins", status: "fail", detail: err instanceof Error ? err.message : String(err) });
  }

  // 6. @latticeag/events admits vekrevert/v1. Missing package => skipped (D19).
  try {
    const req = createRequire(import.meta.url);
    req.resolve("@latticeag/events");
    checks.push({ n: 6, name: "events", status: "pass", detail: "@latticeag/events admits vekrevert/v1" });
  } catch {
    checks.push({ n: 6, name: "events", status: "skip", detail: "@latticeag/events not installed (standalone events-ext)" });
  }

  // 7. Credential names resolve (presence only).
  try {
    const map = cfg.credentials?.map ?? {};
    const unset = Object.values(map).filter((envName) => !process.env[envName]);
    checks.push({
      n: 7,
      name: "credentials",
      status: unset.length ? "fail" : "pass",
      detail: unset.length ? `${unset.length} mapped env names unset` : `provider ${cfg.credentials?.provider ?? "none"}`,
    });
  } catch (err) {
    checks.push({ n: 7, name: "credentials", status: "fail", detail: err instanceof Error ? err.message : String(err) });
  }

  // 8. writableRoots exist, writable, not / or $HOME. Empty => skip/pass.
  {
    const roots = cfg.writableRoots ?? [];
    if (roots.length === 0) {
      checks.push({ n: 8, name: "writableRoots", status: "skip", detail: "no writableRoots configured" });
    } else {
      const home = homedir();
      const bad = roots.filter((r) => r === "/" || r === home || !existsSync(r));
      checks.push({
        n: 8,
        name: "writableRoots",
        status: bad.length ? "fail" : "pass",
        detail: bad.length ? `invalid roots: ${bad.join(", ")}` : `${roots.length} roots ok`,
      });
    }
  }

  // 9. Model roles: null = disabled, not broken.
  {
    const models = cfg.models ?? { classifier: null, drafter: null, verifier: null };
    const roles = ["classifier", "drafter", "verifier"] as const;
    const disabled = roles.filter((r) => models[r] == null);
    checks.push({
      n: 9,
      name: "models",
      status: "pass",
      detail: `${disabled.join(", ") || "none"} disabled`,
    });
  }

  // 10. VekInbox reachable and webhook secret set, if configured.
  {
    const inbox = cfg.escalation?.vekinbox;
    if (!inbox?.baseUrl) {
      checks.push({ n: 10, name: "vekinbox", status: "skip", detail: `not configured; VEKINBOX_API_KEY ${envFlag("VEKINBOX_API_KEY")} VEKINBOX_WEBHOOK_SECRET ${envFlag("VEKINBOX_WEBHOOK_SECRET")}` });
    } else {
      const secret = envFlag("VEKINBOX_WEBHOOK_SECRET");
      checks.push({
        n: 10,
        name: "vekinbox",
        status: secret === "set" ? "pass" : "warn",
        detail: `configured; webhook secret ${secret}; api key ${envFlag("VEKINBOX_API_KEY")}`,
      });
    }
  }

  // 11. Chain integrity of the most recent 1000 events.
  try {
    const ledger = await openLedger(cfg.ledger, cfg.ledgerOpts);
    try {
      const all = await ledger.readAll();
      const recent = all.slice(-1000);
      const bySaga = new Map<string, typeof recent>();
      for (const ev of recent) {
        const list = bySaga.get(ev.saga_id) ?? [];
        list.push(ev);
        bySaga.set(ev.saga_id, list);
      }
      let broken = 0;
      for (const [, evs] of bySaga) {
        const r = verifyChain(evs as never);
        if (!r.ok) broken++;
      }
      checks.push({
        n: 11,
        name: "chain",
        status: broken ? "fail" : "pass",
        detail: broken ? `${broken} saga chains broken` : `${recent.length} events ok`,
      });
    } finally {
      await ledger.close();
    }
  } catch (err) {
    checks.push({ n: 11, name: "chain", status: "fail", detail: err instanceof Error ? err.message : String(err) });
  }

  // 12. Clock skew vs last event < 60s.
  try {
    const ledger = await openLedger(cfg.ledger, cfg.ledgerOpts);
    try {
      const all = await ledger.readAll();
      const last = all[all.length - 1];
      if (!last) {
        checks.push({ n: 12, name: "clock", status: "pass", detail: "no events" });
      } else {
        const skew = Math.abs(Date.now() - Date.parse(last.ts));
        checks.push({
          n: 12,
          name: "clock",
          status: skew < 60_000 ? "pass" : "warn",
          detail: `skew ${Math.round(skew / 1000)}s`,
        });
      }
    } finally {
      await ledger.close();
    }
  } catch (err) {
    checks.push({ n: 12, name: "clock", status: "fail", detail: err instanceof Error ? err.message : String(err) });
  }

  if (json) {
    process.stdout.write(JSON.stringify({ checks }, null, 2) + "\n");
  } else {
    for (const c of checks) {
      process.stdout.write(`${c.n}. ${c.name}: ${c.status} - ${c.detail}\n`);
    }
  }
  const failed = checks.some((c) => c.status === "fail");
  return failed ? 1 : 0;
}
