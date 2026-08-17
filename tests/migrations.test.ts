import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadInitSql, VekRevertError } from "@latticeag/vekrevert-core";
import { openLedger, parseLedgerUrl } from "../sdk-ts/src/ledger/open.ts";
import { LEDGER_TABLE_NAMES } from "../sdk-ts/src/ledger/types.ts";
import { seedFixtureLedger } from "./fixtures/ledger/seed.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "vr-mig-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("migrations", () => {
  it("applies 001_init against sqlite and creates every table", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(loadInitSql("sqlite"));
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const have = names.map((r) => r.name);
    for (const t of LEDGER_TABLE_NAMES) expect(have).toContain(t);
    db.close();
  });

  it("openLedger sqlite applies the same schema", async () => {
    const dir = tmp();
    const path = join(dir, "ledger.db");
    const ledger = await openLedger(`sqlite:${path}`);
    await ledger.close();
    const db = new DatabaseSync(path);
    for (const t of LEDGER_TABLE_NAMES) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      expect(row, t).toBeTruthy();
    }
    db.close();
  });

  it("fsync:never is rejected unless the ledger is memory", async () => {
    await expect(openLedger("sqlite::memory:", { fsync: "never" })).rejects.toBeInstanceOf(VekRevertError);
    await expect(openLedger("sqlite::memory:", { fsync: "never" })).rejects.toMatchObject({ code: "VR2002" });
    const dir = tmp();
    await expect(openLedger(`jsonl:${join(dir, "e.jsonl")}`, { fsync: "never" })).rejects.toMatchObject({
      code: "VR2002",
    });
    const mem = await openLedger("memory", { fsync: "never" });
    expect(mem.kind).toBe("memory");
    await mem.close();
  });

  it("parseLedgerUrl covers every driver scheme", () => {
    expect(parseLedgerUrl("memory").kind).toBe("memory");
    expect(parseLedgerUrl("memory:test").kind).toBe("memory");
    expect(parseLedgerUrl("jsonl:./x.jsonl")).toEqual({ kind: "jsonl", path: "./x.jsonl" });
    expect(parseLedgerUrl("sqlite:./l.db")).toEqual({ kind: "sqlite", path: "./l.db" });
    expect(parseLedgerUrl("postgres://localhost/vr").kind).toBe("postgres");
    expect(parseLedgerUrl("https://api.example.com/v1").kind).toBe("http");
  });

  it("seedFixtureLedger writes a sqlite ledger", async () => {
    const dir = tmp();
    const seeded = await seedFixtureLedger(dir);
    const db = new DatabaseSync(seeded.sqlitePath);
    const n = db.prepare("SELECT COUNT(*) AS n FROM receipt_events").get() as { n: number };
    expect(n.n).toBeGreaterThan(0);
    db.close();
  });
});

describe("postgres migration", () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    it("skips postgres because DATABASE_URL is not set", () => {
      console.log("skipping postgres: DATABASE_URL not set");
      expect(true).toBe(true);
    });
    return;
  }

  it("applies 001_init against postgres and creates every table", async () => {
    const ledger = await openLedger(url);
    await ledger.close();
    const spec = "pg";
    const pg = (await import(spec)) as {
      default?: { Client: new (opts: { connectionString: string }) => PgTestClient };
      Client?: new (opts: { connectionString: string }) => PgTestClient;
    };
    type PgTestClient = {
      connect: () => Promise<void>;
      query: (sql: string) => Promise<{ rows: Array<{ tablename: string }> }>;
      end: () => Promise<void>;
    };
    const Client = pg.Client ?? pg.default?.Client;
    if (!Client) throw new Error("pg Client missing");
    const client = new Client({ connectionString: url });
    await client.connect();
    const res = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`,
    );
    const have = res.rows.map((r: { tablename: string }) => r.tablename);
    for (const t of LEDGER_TABLE_NAMES) expect(have).toContain(t);
    await client.end();
  });
});
