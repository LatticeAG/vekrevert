/** JSONL ledger: one JCS event per line, append-only file. */
import { mkdirSync, readFileSync, existsSync, appendFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { open as fsOpen, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalize, type JsonValue } from "@latticeag/vekrevert-core";
import type { ReceiptEvent } from "@latticeag/vekrevert-events";
import { createMemoryLedger, type AttemptRecord, type Ledger, type LedgerOpenOptions } from "./types.ts";

function loadLines(path: string): ReceiptEvent[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const events: ReceiptEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    events.push(JSON.parse(line) as ReceiptEvent);
  }
  return events;
}

function fsyncAppend(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    appendFileSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export async function openJsonlLedger(path: string, opts: LedgerOpenOptions = {}): Promise<Ledger> {
  mkdirSync(dirname(path), { recursive: true });
  const initial = loadLines(path);
  const fh: FileHandle = await fsOpen(path, "a");
  const attemptsPath = `${path}.attempts.jsonl`;

  return createMemoryLedger(
    opts,
    initial,
    {
      async persistEvent(ev: ReceiptEvent, fsync: boolean) {
        const line = canonicalize(ev as unknown as JsonValue) + "\n";
        await fh.write(line);
        if (fsync) await fh.sync();
      },
      async persistAttempt(row: AttemptRecord, fsync: boolean) {
        const line = canonicalize(row as unknown as JsonValue) + "\n";
        if (fsync) fsyncAppend(attemptsPath, line);
        else appendFileSync(attemptsPath, line);
      },
      async flush() {
        await fh.sync();
      },
      async close() {
        await fh.sync();
        await fh.close();
      },
    },
    "jsonl",
  );
}
