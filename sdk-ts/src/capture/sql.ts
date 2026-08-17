/** instrumentSqlite / instrumentPg. Capture SELECT * preimage for UPDATE/DELETE. */

import { classifySql, type ActionRef, type JsonValue } from "@latticeag/vekrevert-core";
import { closeEffect, openEffect, type EffectHost } from "../effect.ts";

export interface SqliteLike {
  prepare: (sql: string) => {
    run?: (...args: unknown[]) => unknown;
    all?: (...args: unknown[]) => unknown[];
    get?: (...args: unknown[]) => unknown;
  };
  exec: (sql: string) => unknown;
}

export interface PgPoolLike {
  query?: (text: unknown, params?: unknown) => unknown;
}

function sqlAction(sql: string, table?: string): ActionRef {
  const kind = classifySql(sql).kind;
  return {
    kind: "sql",
    name: `sql.${kind}.${table ?? "t"}`,
    target: "app",
    locality: "internal",
  };
}

function extractWhere(sql: string): string {
  const m = /\bWHERE\b([\s\S]*?)(?:\bRETURNING\b|\bORDER\b|\bLIMIT\b|;|$)/i.exec(sql);
  return m ? `WHERE ${m[1]!.trim()}` : "";
}

function captureRows(db: SqliteLike, sql: string, params: unknown[]): unknown[] | undefined {
  const parsed = classifySql(sql);
  if (parsed.kind !== "UPDATE" && parsed.kind !== "DELETE") return undefined;
  if (!parsed.table) return undefined;
  const where = extractWhere(sql);
  const q = `SELECT * FROM ${parsed.table}${where ? ` ${where}` : ""}`;
  try {
    const stmt = db.prepare(q);
    if (typeof stmt.all === "function") return stmt.all(...params);
    if (typeof stmt.get === "function") {
      const row = stmt.get(...params);
      return row == null ? [] : [row];
    }
  } catch {
    try {
      const stmt = db.prepare(`SELECT * FROM ${parsed.table}`);
      if (typeof stmt.all === "function") return stmt.all();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function runSql<T>(
  host: EffectHost,
  sql: string,
  params: unknown[],
  rows: unknown[] | undefined,
  run: () => T | Promise<T>,
): Promise<T> {
  const sagaId = host.currentSagaId;
  if (!sagaId || !host.ledgerHandle) return await run();
  const parsed = classifySql(sql);
  const args: JsonValue = {
    sql,
    statement: parsed.kind,
    table: parsed.table ?? null,
    params: JSON.parse(JSON.stringify(params ?? [])) as JsonValue,
  };
  const opened = await openEffect(host, sagaId, {
    action: sqlAction(sql, parsed.table),
    args,
    run: async () => null,
    capture: { fidelity: "full", interceptor: "instrumentSql" },
    capturePreimage:
      rows != null
        ? () => ({ kind: "sql_rows" as const, rows, meta: { table: parsed.table ?? "" } })
        : undefined,
  });
  try {
    const value = await run();
    await closeEffect(host, opened, { value: value as never, result: value as never });
    return value;
  } catch (err) {
    try {
      await closeEffect(host, opened, { error: err });
    } catch {
      /* isolation */
    }
    throw err;
  }
}

export function instrumentSqlite(host: EffectHost, db: SqliteLike): Disposable {
  const origPrepare = db.prepare.bind(db);
  const origExec = db.exec.bind(db);

  db.prepare = ((sql: string) => {
    const stmt = origPrepare(sql);
    const origRun = stmt.run?.bind(stmt);
    const origAll = stmt.all?.bind(stmt);
    const origGet = stmt.get?.bind(stmt);
    if (origRun) {
      stmt.run = (...params: unknown[]) => {
        const rows = captureRows(db, sql, params);
        return runSql(host, sql, params, rows, () => origRun(...params));
      };
    }
    if (origAll) {
      stmt.all = (...params: unknown[]) => origAll(...params);
    }
    if (origGet) {
      stmt.get = (...params: unknown[]) => origGet(...params);
    }
    return stmt;
  }) as typeof db.prepare;

  db.exec = ((sql: string) => {
    const rows = captureRows(db, sql, []);
    return runSql(host, sql, [], rows, () => origExec(sql));
  }) as typeof db.exec;

  return {
    [Symbol.dispose]: () => {
      db.prepare = origPrepare;
      db.exec = origExec;
    },
  };
}

export function instrumentPg(host: EffectHost, pool: PgPoolLike): Disposable {
  if (!pool || typeof pool.query !== "function") {
    return { [Symbol.dispose]: () => undefined };
  }
  const orig = pool.query.bind(pool);
  pool.query = ((text: unknown, params?: unknown) => {
    const sql = typeof text === "string" ? text : String((text as { text?: string })?.text ?? text);
    const values = typeof text === "string" ? (params as unknown[]) : ((text as { values?: unknown[] })?.values ?? (params as unknown[]));
    const parsed = classifySql(sql);
    let rows: unknown[] | undefined;
    if ((parsed.kind === "UPDATE" || parsed.kind === "DELETE") && parsed.table) {
      const where = extractWhere(sql);
      const q = `SELECT * FROM ${parsed.table}${where ? ` ${where}` : ""}`;
      try {
        const pre = orig(q, values);
        if (pre && typeof (pre as Promise<unknown>).then === "function") {
          return (pre as Promise<{ rows?: unknown[] }>).then((r) => {
            rows = r?.rows;
            return runSql(host, sql, values ?? [], rows, () => orig(text, params));
          });
        }
        rows = (pre as { rows?: unknown[] })?.rows;
      } catch {
        rows = undefined;
      }
    }
    return runSql(host, sql, values ?? [], rows, () => orig(text, params));
  }) as typeof pool.query;

  return {
    [Symbol.dispose]: () => {
      pool.query = orig;
    },
  };
}
