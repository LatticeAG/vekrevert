/** Postgres ledger. Same DDL as SQLite via loadInitSql("postgres"). */
import { loadInitSql, VekRevertError } from "@latticeag/vekrevert-core";
import {
  createSqlLedger,
  type Ledger,
  type LedgerOpenOptions,
  type SqlAdapter,
} from "./types.ts";

type PgClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
};

export const POSTGRES_SKIP_LOCKED = `SELECT resource_key FROM leases WHERE resource_key = $1 FOR UPDATE SKIP LOCKED`;

type PgModule = {
  default?: { Client: new (opts: { connectionString: string }) => PgClient & { connect: () => Promise<void> } };
  Client?: new (opts: { connectionString: string }) => PgClient & { connect: () => Promise<void> };
};

async function loadPg(): Promise<PgModule> {
  try {
    const spec = "pg";
    return (await import(spec)) as PgModule;
  } catch (err) {
    const hasUrl = Boolean(process.env.DATABASE_URL);
    throw new Error(
      hasUrl
        ? "postgres ledger: DATABASE_URL is set but the `pg` package failed to load"
        : "postgres ledger requires the `pg` package (and a postgres:// URL or DATABASE_URL)",
      { cause: err },
    );
  }
}

function pgAdapter(client: PgClient): SqlAdapter {
  return {
    dialect: "postgres",
    async exec(sql) {
      await client.query(sql);
    },
    async run(sql, params = []) {
      await client.query(sql, params);
    },
    async get(sql, params = []) {
      const res = await client.query(sql, params);
      return res.rows[0];
    },
    async all(sql, params = []) {
      const res = await client.query(sql, params);
      return res.rows;
    },
    async tx(_mode, fn) {
      await client.query("BEGIN");
      try {
        const result = await fn();
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* already aborted */
        }
        throw err;
      }
    },
    async durableFlush() {
      await client.query("SELECT pg_current_wal_lsn()");
    },
    async close() {
      await client.end();
    },
  };
}

export async function openPostgresLedger(url: string, opts: LedgerOpenOptions = {}): Promise<Ledger> {
  const connectionString = url || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new VekRevertError("VR2002", "postgres ledger requires a postgres:// URL or DATABASE_URL");
  }
  const pg = await loadPg();
  const Client = pg.Client ?? pg.default?.Client;
  if (!Client) throw new Error("postgres ledger: `pg` loaded but Client export is missing");
  const client = new Client({ connectionString });
  await client.connect();
  const adapter = pgAdapter(client);
  const existing = await adapter.get("SELECT to_regclass('receipt_events') AS name");
  if (!existing?.name) {
    await adapter.exec(loadInitSql("postgres"));
  }
  return createSqlLedger("postgres", adapter, opts);
}

/** Factory used when `pg` cannot be loaded. Throws unless DATABASE_URL is set, then still throws on import failure. */
export function postgresLedgerFactory(url?: string, opts?: LedgerOpenOptions): Promise<Ledger> {
  return openPostgresLedger(url ?? process.env.DATABASE_URL ?? "", opts);
}
