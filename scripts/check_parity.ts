#!/usr/bin/env tsx
/**
 * Fails if a docs/parity.md table row is missing from TS exports or Python __all__.
 * docs/parity.md is the only public-surface source of truth.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VekRevert } from "@latticeag/vekrevert";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const TS_METHODS = [
  "openSaga",
  "resumeSaga",
  "classify",
  "plan",
  "verify",
  "execute",
  "undo",
  "status",
  "receipts",
  "escalate",
  "wrapFetch",
  "instrumentFs",
  "instrumentPg",
  "wrapMcpServer",
] as const;

const TS_REGISTRY = ["register", "list", "match"] as const;

const TS_SAGA_EFFECT = "effect";

const PY_NAMES = [
  "saga",
  "resume_saga",
  "classify",
  "plan",
  "verify",
  "execute",
  "undo",
  "status",
  "receipts",
  "escalate",
  "instrument_httpx",
  "instrument_fs",
  "instrument_sqlalchemy",
  "instrument_mcp",
] as const;

function parseParityTable(md: string): { ts: string; py: string }[] {
  const rows: { ts: string; py: string }[] = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("|") || line.includes("---") || line.includes("TS | Python")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    rows.push({ ts: cells[0]!, py: cells[1]! });
  }
  return rows;
}

function extractBackticked(cell: string): string[] {
  const out: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cell))) {
    const raw = m[1]!;
    for (const part of raw.split("/")) {
      const name = part.trim().replace(/\(.*$/, "").replace(/^saga\./, "");
      if (name) out.push(name);
    }
  }
  return out;
}

function main(): void {
  const md = readFileSync(join(root, "docs/parity.md"), "utf8");
  const rows = parseParityTable(md);
  if (rows.length < 6) {
    process.stderr.write("check_parity: expected at least 6 table rows in docs/parity.md\n");
    process.exit(1);
  }

  const proto = VekRevert.prototype as unknown as Record<string, unknown>;
  const missingTs: string[] = [];
  for (const m of TS_METHODS) {
    if (typeof proto[m] !== "function") missingTs.push(`VekRevert.${m}`);
  }
  const sample = new VekRevert({ ledger: "memory" });
  for (const m of TS_REGISTRY) {
    if (typeof (sample.registry as unknown as Record<string, unknown>)[m] !== "function") {
      missingTs.push(`VekRevert.registry.${m}`);
    }
  }
  void TS_SAGA_EFFECT;

  const pyInit = readFileSync(
    join(root, "sdk-python/src/latticeag_vekrevert/__init__.py"),
    "utf8",
  );
  const allMatch = pyInit.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
  if (!allMatch) {
    process.stderr.write("check_parity: Python __all__ not found\n");
    process.exit(1);
  }
  const pyAll = [...allMatch[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  const missingPy: string[] = [];
  for (const n of PY_NAMES) {
    if (!pyAll.includes(n)) missingPy.push(n);
  }

  const tableTs = new Set<string>();
  const tablePy = new Set<string>();
  for (const row of rows) {
    for (const t of extractBackticked(row.ts)) tableTs.add(t);
    for (const p of extractBackticked(row.py)) tablePy.add(p);
  }

  const requiredTsTokens = [
    "openSaga",
    "resumeSaga",
    "effect",
    "classify",
    "plan",
    "verify",
    "execute",
    "undo",
    "status",
    "receipts",
    "escalate",
    "register",
    "list",
    "match",
    "wrapFetch",
    "instrumentFs",
    "instrumentPg",
    "wrapMcpServer",
  ];
  const requiredPyTokens = [
    "saga",
    "resume_saga",
    "effect",
    "classify",
    "plan",
    "verify",
    "execute",
    "undo",
    "status",
    "receipts",
    "escalate",
    "register",
    "list",
    "match",
    "instrument_httpx",
    "instrument_fs",
    "instrument_sqlalchemy",
    "instrument_mcp",
  ];

  for (const t of requiredTsTokens) {
    if (![...tableTs].some((x) => x.includes(t))) missingTs.push(`parity.md missing TS token ${t}`);
  }
  for (const p of requiredPyTokens) {
    if (![...tablePy].some((x) => x.includes(p))) missingPy.push(`parity.md missing Python token ${p}`);
  }

  if (missingTs.length || missingPy.length) {
    process.stderr.write("check_parity: FAIL\n");
    for (const x of missingTs) process.stderr.write(`  TS: ${x}\n`);
    for (const x of missingPy) process.stderr.write(`  PY: ${x}\n`);
    process.exit(1);
  }
  process.stdout.write("check_parity: ok\n");
}

main();
