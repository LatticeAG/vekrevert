#!/usr/bin/env node
import { runCli } from "./index.ts";

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
}
const code = await runCli(args);
process.exit(code);
