/** Dialect-templated SQL from packages/core/migrations/001_init.sql */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SqlDialectName = "sqlite" | "postgres";

const SQLITE_IMMUTABLE = `
CREATE TRIGGER receipt_events_immutable BEFORE UPDATE ON receipt_events
  BEGIN SELECT RAISE(ABORT, 'VR2015 chain_broken: receipt_events is append-only'); END;
CREATE TRIGGER receipt_events_nodelete BEFORE DELETE ON receipt_events
  BEGIN SELECT RAISE(ABORT, 'VR2015 chain_broken: receipt_events is append-only'); END;
`;

const POSTGRES_IMMUTABLE = `
CREATE OR REPLACE FUNCTION receipt_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'VR2015 chain_broken: receipt_events is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER receipt_events_immutable BEFORE UPDATE ON receipt_events
  FOR EACH ROW EXECUTE FUNCTION receipt_events_immutable();
CREATE TRIGGER receipt_events_nodelete BEFORE DELETE ON receipt_events
  FOR EACH ROW EXECUTE FUNCTION receipt_events_immutable();
`;

export function templateMigration(sql: string, dialect: SqlDialectName): string {
  const text = dialect === "postgres" ? "text" : "TEXT";
  const integer = dialect === "postgres" ? "bigint" : "INTEGER";
  const blob = dialect === "postgres" ? "bytea" : "BLOB";
  const immutable = dialect === "postgres" ? POSTGRES_IMMUTABLE : SQLITE_IMMUTABLE;
  return sql
    .replaceAll("{{TEXT}}", text)
    .replaceAll("{{INTEGER}}", integer)
    .replaceAll("{{BLOB}}", blob)
    .replaceAll("{{RECEIPT_EVENTS_IMMUTABLE}}", immutable);
}

export function loadInitSql(dialect: SqlDialectName): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "../migrations/001_init.sql"), "utf8");
  return templateMigration(raw, dialect);
}

/** Coordinator process schema. Not applied to receipt ledgers. */
export function loadCoordinatorSql(dialect: SqlDialectName = "sqlite"): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "../migrations/002_coordinator.sql"), "utf8");
  return templateMigration(raw, dialect);
}
