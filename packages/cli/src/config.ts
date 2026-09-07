/** Load vekrevert.config.json from cwd. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VekRevertConfig } from "@latticeag/vekrevert-core";

function envAllowDrafted(): boolean {
  const v = process.env.VEKREVERT_ALLOW_DRAFTED;
  return v === "1" || v === "true" || v === "TRUE" || v === "yes";
}

function envBlockT4(): boolean | undefined {
  const v = process.env.VEKREVERT_BLOCK_T4;
  if (v == null || v === "") return undefined;
  return v === "1" || v === "true" || v === "TRUE" || v === "yes";
}

export function loadWorkspaceConfig(cwd: string = process.cwd()): VekRevertConfig {
  const file = join(cwd, "vekrevert.config.json");
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, "utf8")) as VekRevertConfig;
    return {
      ...raw,
      ledger: process.env.VEKREVERT_LEDGER ?? raw.ledger,
      allowDrafted: raw.allowDrafted === true || envAllowDrafted(),
      policy: { blockT4: envBlockT4() ?? raw.policy?.blockT4 ?? false, ...raw.policy, ...(envBlockT4() != null ? { blockT4: envBlockT4() } : {}) },
      verification: {
        ...raw.verification,
        mode: envVerificationModeRaw() ?? raw.verification?.mode ?? "audit",
      },
      coordinatorUrl: process.env.VEKREVERT_COORDINATOR_URL ?? raw.coordinatorUrl,
    };
  }
  return {
    ledger: process.env.VEKREVERT_LEDGER ?? "sqlite:./.vekrevert/ledger.db",
    allowDrafted: envAllowDrafted(),
    policy: { blockT4: envBlockT4() ?? false },
    verification: { mode: envVerificationModeRaw() ?? "audit" },
    coordinatorUrl: process.env.VEKREVERT_COORDINATOR_URL,
  };
}

function envVerificationModeRaw(): "off" | "audit" | "enforce" | undefined {
  const v = process.env.VEKREVERT_VERIFICATION_MODE?.trim().toLowerCase();
  if (v === "off" || v === "audit" || v === "enforce") return v;
  return undefined;
}

export function ledgerUrlFromConfig(cfg: VekRevertConfig): string {
  return process.env.VEKREVERT_LEDGER ?? cfg.ledger ?? "sqlite:./.vekrevert/ledger.db";
}
