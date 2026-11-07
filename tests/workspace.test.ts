import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findWorkspace, resolveWorkspaceDir } from "../packages/cli/src/workspace.ts";

function makeWorkspace(withLedger: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "vr-workspace-"));
  if (withLedger) {
    mkdirSync(join(dir, ".vekrevert"), { recursive: true });
    writeFileSync(join(dir, ".vekrevert", "ledger.db"), "");
  }
  return dir;
}

describe("workspace resolution", () => {
  it("finds a ledger in the directory itself", () => {
    const ws = makeWorkspace(true);
    expect(findWorkspace(ws)).toBe(ws);
  });

  it("walks up to a parent that holds the ledger", () => {
    const ws = makeWorkspace(true);
    const nested = join(ws, "packages", "cli");
    mkdirSync(nested, { recursive: true });
    expect(findWorkspace(nested)).toBe(ws);
  });

  it("returns undefined when no ledger exists", () => {
    expect(findWorkspace(makeWorkspace(false))).toBeUndefined();
  });

  it("prefers INIT_CWD over the directory pnpm --dir moved us into", () => {
    const ws = makeWorkspace(true);
    const packageDir = makeWorkspace(false);
    expect(resolveWorkspaceDir(packageDir, ws, undefined)).toBe(ws);
  });

  it("respects an explicit VEKREVERT_LEDGER instead of guessing", () => {
    const cwd = makeWorkspace(false);
    const other = makeWorkspace(true);
    expect(resolveWorkspaceDir(cwd, other, "sqlite:/tmp/custom.db")).toBe(cwd);
  });

  it("leaves cwd alone when there is nothing better", () => {
    const cwd = makeWorkspace(false);
    const unrelated = makeWorkspace(false);
    expect(resolveWorkspaceDir(cwd, unrelated, undefined)).toBe(unrelated);
    expect(resolveWorkspaceDir(cwd, undefined, undefined)).toBe(cwd);
  });
});