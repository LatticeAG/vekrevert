import { createMemoryLedger } from "./types.ts";
import { openMemoryLedger } from "./memory.ts";
import { openJsonlLedger } from "./jsonl.ts";
import { openSqliteLedger } from "./sqlite.ts";
import { openPostgresLedger } from "./postgres.ts";
import { openHttpLedger } from "./http.ts";
import { rejectFsyncNever, type Ledger, type LedgerKind, type LedgerOpenOptions } from "./types.ts";
import { attachCoordinatorLeases, resolveCoordinatorUrl } from "../coordinate/client.ts";

export const DEFAULT_SQLITE_PATH = "./.vekrevert/ledger.db";

export interface ParsedLedgerUrl {
  kind: LedgerKind;
  path?: string;
  url?: string;
}

export function parseLedgerUrl(raw: string): ParsedLedgerUrl {
  if (raw === "memory" || raw.startsWith("memory:")) return { kind: "memory" };
  if (raw.startsWith("jsonl:")) return { kind: "jsonl", path: raw.slice("jsonl:".length) };
  if (raw === "sqlite" || raw === "sqlite:") return { kind: "sqlite", path: DEFAULT_SQLITE_PATH };
  if (raw.startsWith("sqlite:")) {
    const path = raw.slice("sqlite:".length);
    return { kind: "sqlite", path: path || DEFAULT_SQLITE_PATH };
  }
  if (raw.startsWith("postgres://") || raw.startsWith("postgresql://")) {
    return { kind: "postgres", url: raw };
  }
  if (raw.startsWith("https://") || raw.startsWith("http://")) {
    return { kind: "http", url: raw };
  }
  throw new Error(`unrecognized ledger URL: ${raw}`);
}

export async function openLedger(
  raw: string = `sqlite:${DEFAULT_SQLITE_PATH}`,
  opts: LedgerOpenOptions = {},
): Promise<Ledger> {
  const parsed = parseLedgerUrl(raw);
  rejectFsyncNever(parsed.kind, opts.fsync);

  let ledger: Ledger;
  switch (parsed.kind) {
    case "memory": {
      openMemoryLedger();
      ledger = createMemoryLedger(opts, [], {}, "memory");
      break;
    }
    case "jsonl":
      ledger = await openJsonlLedger(parsed.path!, opts);
      break;
    case "sqlite":
      ledger = openSqliteLedger(parsed.path!, opts);
      break;
    case "postgres":
      ledger = await openPostgresLedger(parsed.url!, opts);
      break;
    case "http":
      ledger = openHttpLedger(parsed.url!, opts);
      break;
    default:
      throw new Error(`unrecognized ledger kind: ${String((parsed as { kind: string }).kind)}`);
  }
  const coordinatorUrl = resolveCoordinatorUrl(opts.coordinatorUrl);
  if (coordinatorUrl && parsed.kind !== "http") {
    return attachCoordinatorLeases(ledger, coordinatorUrl, { fetch: opts.fetch });
  }
  return ledger;
}
