/** CLI package version, read from its own package.json so --version tracks releases. */

import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: string };

export const CLI_VERSION: string = pkg.version ?? "0.0.0";
