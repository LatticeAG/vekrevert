#!/usr/bin/env node
import { resolve } from "node:path";
import { runCli } from "./index.ts";
import { resolveWorkspaceDir } from "./workspace.ts";

const args = process.argv.slice(2);
const workspaceIndex = args.indexOf("--workspace");
if (workspaceIndex !== -1) {
  const workspace = args[workspaceIndex + 1];
  if (!workspace || workspace.startsWith("-")) {
    process.stderr.write("vekrevert: --workspace requires a directory\n");
    process.exit(2);
  }
  try {
    process.chdir(workspace);
  } catch (err) {
    process.stderr.write(`vekrevert: cannot use workspace ${workspace} from ${process.cwd()}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  args.splice(workspaceIndex, 2);
} else if (process.env.VEKREVERT_LEDGER == null) {
  // Only guess when the caller has not pointed at a ledger explicitly.
  const target = resolveWorkspaceDir(process.cwd(), process.env.INIT_CWD, process.env.VEKREVERT_LEDGER);
  if (resolve(target) !== resolve(process.cwd())) {
    process.chdir(target);
  }
}
const code = await runCli(args);
process.exit(code);
