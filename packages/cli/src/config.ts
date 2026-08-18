/** Load vekrevert.config.json from cwd. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VekRevertConfig } from "@latticeag/vekrevert-core";

function envAllowDrafted(): boolean {
  const v = process.env.VEKREVERT_ALLOW_DRAFTED;
  return v === "1" || v === "true" || v === "TRUE" || v === "yes";
}

export function loadWorkspaceConfig(cwd: string = process.cwd()): VekRevertConfig {
  const file = join(cwd, "vekrevert.config.json");
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, "utf8")) as VekRevertConfig;
    return {
      ...raw,
      allowDrafted: raw.allowDrafted === true || envAllowDrafted(),
      policy: { blockT4: false, ...raw.policy },
    };
  }
  return {
    ledger: process.env.VEKREVERT_LEDGER ?? "sqlite:./.vekrevert/ledger.db",
    allowDrafted: envAllowDrafted(),
    policy: { blockT4: false },
  };
}

export function ledgerUrlFromConfig(cfg: VekRevertConfig): string {
  return process.env.VEKREVERT_LEDGER ?? cfg.ledger ?? "sqlite:./.vekrevert/ledger.db";
}
