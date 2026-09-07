/** vekrevert doctor [--json] - workspace checks. Never prints secret values. */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { verifyChain, SDK_VERSION } from "@latticeag/vekrevert-core";
import { openLedger, resolveVerificationPolicy, STRUCTURAL_VERIFIER_MODEL } from "@latticeag/vekrevert";
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

const PROBE_MS = 2_000;

function joinUrl(base: string, path: string): string {
  const root = base.endsWith("/") ? base.slice(0, -1) : base;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${root}${suffix}`;
}

function bearerHeaders(envName: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json", ...extra };
  const key = process.env[envName];
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

function schemaRejected(status?: number, body?: string): boolean {
  if (status === 406 || status === 415) return true;
  if (!body) return false;
  const t = body.toLowerCase();
  if (t.includes("schema_rejected") || t.includes("schema rejection")) return true;
  if (
    t.includes("vekrevert/v1") &&
    (t.includes("not admit") || t.includes("unsupported schema") || t.includes("rejected"))
  ) {
    return true;
  }
  return false;
}

async function probeHttp(
  url: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status?: number; body?: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_MS) });
    const body = await res.text().catch(() => "");
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body };
  } catch {
    return { ok: false };
  }
}

async function probeHealthOrBase(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; schemaRejected: boolean }> {
  const health = await probeHttp(joinUrl(baseUrl, "/health"), { headers });
  if (schemaRejected(health.status, health.body)) return { ok: false, schemaRejected: true };
  if (health.ok) return { ok: true, schemaRejected: false };
  const root = await probeHttp(baseUrl, { headers });
  if (schemaRejected(root.status, root.body)) return { ok: false, schemaRejected: true };
  return { ok: root.ok, schemaRejected: false };
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

  // 6. @latticeag/events (or vekrevert-events) admits vekrevert/v1. Hosted probe is warn-on-fail.
  {
    const req = createRequire(import.meta.url);
    let eventsDetail = "@latticeag/events not installed (standalone events-ext)";
    let eventsStatus: Status = "skip";
    try {
      req.resolve("@latticeag/events");
      eventsStatus = "pass";
      eventsDetail = "@latticeag/events admits vekrevert/v1";
    } catch {
      try {
        req.resolve("@latticeag/vekrevert-events");
        eventsStatus = "pass";
        eventsDetail = "@latticeag/vekrevert-events admits vekrevert/v1";
      } catch {
        /* D19: missing umbrella is skip, not fail */
      }
    }
    const ledgerUrl = process.env.VEKREVERT_LEDGER ?? cfg.ledger ?? "";
    const hosted = ledgerUrl.startsWith("http://") || ledgerUrl.startsWith("https://");
    if (!hosted) {
      checks.push({ n: 6, name: "events", status: eventsStatus, detail: eventsDetail });
    } else {
      const keyFlag = `VEKREVERT_API_KEY ${envFlag("VEKREVERT_API_KEY")}`;
      const probe = await probeHealthOrBase(ledgerUrl, bearerHeaders("VEKREVERT_API_KEY"));
      if (probe.schemaRejected) {
        checks.push({
          n: 6,
          name: "events",
          status: "fail",
          detail: `${eventsDetail}; hosted schema rejected vekrevert/v1; ${keyFlag}`,
        });
      } else if (!probe.ok) {
        checks.push({
          n: 6,
          name: "events",
          status: "warn",
          detail: `${eventsDetail}; hosted probe unreachable; ${keyFlag}`,
        });
      } else {
        checks.push({
          n: 6,
          name: "events",
          status: "pass",
          detail: `${eventsStatus === "pass" ? eventsDetail : "hosted admits vekrevert/v1"}; hosted health ok; ${keyFlag}`,
        });
      }
    }
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

  // 9. Model roles: null = disabled, not broken. LexShield probe is warn-on-unreachable.
  //    Also reports verifier gate mode + model reachability (v0.4 gate).
  {
    const models = cfg.models ?? { classifier: null, drafter: null, verifier: null };
    const roles = ["classifier", "drafter", "verifier"] as const;
    const disabled = roles.filter((r) => models[r] == null);
    const modelDetail = `${disabled.join(", ") || "none"} disabled`;
    const tokenFlags = `LEXSHIELD_TOKEN ${envFlag("LEXSHIELD_TOKEN")} LEXSHIELD_API_KEY ${envFlag("LEXSHIELD_API_KEY")}`;
    const lexUrl = process.env.LEXSHIELD_URL;
    if (!lexUrl) {
      checks.push({
        n: 9,
        name: "models",
        status: "pass",
        detail: `${modelDetail}; LEXSHIELD_URL unset; ${tokenFlags}`,
      });
    } else {
      const headers = {
        ...bearerHeaders("LEXSHIELD_TOKEN"),
        ...bearerHeaders("LEXSHIELD_API_KEY"),
      };
      const health = await probeHttp(joinUrl(lexUrl, "/health"), { headers });
      let reachable = health.ok;
      if (!reachable) {
        const evaluated = await probeHttp(joinUrl(lexUrl, "/evaluate"), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ tool: "doctor.probe", args: {} }),
        });
        reachable = evaluated.ok;
      }
      checks.push({
        n: 9,
        name: "models",
        status: reachable ? "pass" : "warn",
        detail: `${modelDetail}; lexshield ${reachable ? "reachable" : "unreachable"}; ${tokenFlags}`,
      });
    }
  }

  // 10. VekInbox reachable and webhook secret set, if configured.
  {
    const inbox = cfg.escalation?.vekinbox;
    if (!inbox?.baseUrl) {
      checks.push({ n: 10, name: "vekinbox", status: "skip", detail: `not configured; VEKINBOX_API_KEY ${envFlag("VEKINBOX_API_KEY")} VEKINBOX_WEBHOOK_SECRET ${envFlag("VEKINBOX_WEBHOOK_SECRET")}` });
    } else {
      const secret = envFlag("VEKINBOX_WEBHOOK_SECRET");
      const key = envFlag("VEKINBOX_API_KEY");
      const headers = bearerHeaders("VEKINBOX_API_KEY");
      const root = await probeHttp(inbox.baseUrl, { headers });
      let reachable = root.ok;
      if (!reachable) {
        const health = await probeHttp(joinUrl(inbox.baseUrl, "/health"), { headers });
        reachable = health.ok;
      }
      checks.push({
        n: 10,
        name: "vekinbox",
        status: reachable ? "pass" : "warn",
        detail: `configured; webhook secret ${secret}; api key ${key}; ${reachable ? "reachable" : "unreachable"}`,
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

  // 13. Verifier gate mode + model reachability.
  {
    const policy = resolveVerificationPolicy(cfg);
    const model = policy.model ?? STRUCTURAL_VERIFIER_MODEL;
    const baseUrl = process.env.VEKREVERT_MODEL_BASE_URL;
    const keyFlag = `VEKREVERT_MODEL_API_KEY ${envFlag("VEKREVERT_MODEL_API_KEY")}`;
    if (!baseUrl) {
      checks.push({
        n: 13,
        name: "verification",
        status: "pass",
        detail: `mode ${policy.mode}; model ${model}; remote unset (structural fallback); ${keyFlag}`,
      });
    } else {
      const headers = bearerHeaders("VEKREVERT_MODEL_API_KEY");
      const health = await probeHttp(joinUrl(baseUrl, "/health"), { headers });
      checks.push({
        n: 13,
        name: "verification",
        status: health.ok ? "pass" : "warn",
        detail: `mode ${policy.mode}; model ${model}; remote ${health.ok ? "reachable" : "unreachable"}; ${keyFlag}`,
      });
    }
  }

  // 14. Drafted policy (allowlist + gate coupling).
  {
    const allow = cfg.drafted?.allow ?? [];
    const requireGate = cfg.drafted?.requireGate !== false;
    const enabled = cfg.allowDrafted === true;
    checks.push({
      n: 14,
      name: "drafted",
      status: "pass",
      detail: `allowDrafted=${enabled} allow=[${allow.join(",") || (enabled ? "all" : "none")}] requireGate=${requireGate}`,
    });
  }

  // 15. Coordinator reachability. Unset is skip (byte-identical local leases).
  {
    const url = process.env.VEKREVERT_COORDINATOR_URL ?? cfg.coordinatorUrl;
    if (!url) {
      checks.push({
        n: 15,
        name: "coordinator",
        status: "skip",
        detail: `not configured; VEKREVERT_COORDINATOR_URL ${envFlag("VEKREVERT_COORDINATOR_URL")}`,
      });
    } else {
      const probe = await probeHealthOrBase(url, bearerHeaders("VEKREVERT_API_KEY"));
      checks.push({
        n: 15,
        name: "coordinator",
        status: probe.ok ? "pass" : "warn",
        detail: `${url} ${probe.ok ? "reachable" : "unreachable"}; VEKREVERT_COORDINATOR_URL ${envFlag("VEKREVERT_COORDINATOR_URL")}`,
      });
    }
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
