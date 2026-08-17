/** SQLite ledger. Default driver. Node 24 `node:sqlite` DatabaseSync. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadInitSql } from "@latticeag/vekrevert-core";
import {
  createSqlLedger,
  wrapSqliteError,
  type Ledger,
  type LedgerOpenOptions,
  type SqlAdapter,
} from "./types.ts";

function ensureParent(path: string): void {
  if (path === ":memory:" || path === "") return;
  mkdirSync(dirname(path), { recursive: true });
}

function sqliteAdapter(db: DatabaseSync): SqlAdapter {
  return {
    dialect: "sqlite",
    async exec(sql) {
      try {
        db.exec(sql);
      } catch (err) {
        wrapSqliteError(err);
      }
    },
    async run(sql, params = []) {
      try {
        db.prepare(sql).run(...(params as never[]));
      } catch (err) {
        wrapSqliteError(err);
      }
    },
    async get(sql, params = []) {
      try {
        const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
        return row;
      } catch (err) {
        wrapSqliteError(err);
      }
    },
    async all(sql, params = []) {
      try {
        return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
      } catch (err) {
        wrapSqliteError(err);
      }
    },
    async tx(mode, fn) {
      db.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        const result = await fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* already aborted */
        }
        wrapSqliteError(err);
      }
    },
    async durableFlush() {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        /* :memory: and DELETE journal have nothing to checkpoint */
      }
    },
    async close() {
      db.close();
    },
  };
}

export function openSqliteLedger(path: string, opts: LedgerOpenOptions = {}): Ledger {
  ensureParent(path);
  const db = new DatabaseSync(path, { timeout: 5000 });
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='receipt_events'").get();
  if (!existing) db.exec(loadInitSql("sqlite"));
  return createSqlLedger("sqlite", sqliteAdapter(db), opts);
}
