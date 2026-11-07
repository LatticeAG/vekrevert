import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Locate the workspace that actually holds a ledger.
 *
 * `pnpm --dir <repo> exec ...` changes the process cwd to the package directory, so the
 * default `./.vekrevert/ledger.db` silently resolves somewhere else and a valid plan id
 * comes back as `VR3001 unknown plan`. pnpm still exports the directory the operator was
 * in as INIT_CWD, so the CLI resolves against that when it is available.
 *
 * @returns the nearest directory at or above `start` containing `.vekrevert/ledger.db`,
 *          or undefined when there is none.
 */
export function findWorkspace(start: string): string | undefined {
  let dir = resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, ".vekrevert", "ledger.db"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Decide the directory the CLI should operate in.
 *
 * Explicit `--workspace` wins (handled by the caller). A caller-supplied
 * `VEKREVERT_LEDGER` also wins, because it names the ledger directly. Otherwise, if pnpm
 * moved us with `--dir`, prefer INIT_CWD - that is the directory the operator meant.
 */
export function resolveWorkspaceDir(
  cwd: string,
  initCwd: string | undefined,
  ledgerEnv: string | undefined,
): string {
  if (ledgerEnv != null) return cwd;
  if (initCwd && resolve(initCwd) !== resolve(cwd)) {
    return findWorkspace(initCwd) ?? resolve(initCwd);
  }
  return findWorkspace(cwd) ?? cwd;
}