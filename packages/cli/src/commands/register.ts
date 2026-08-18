/** vekrevert register <path...> [--dry-run] [--sign] [--force] [--keygen] */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { isPlanRejection, type ActionSignature } from "@latticeag/vekrevert-core";
import { CompensatorRegistry, gateManifest, signManifest } from "@latticeag/vekrevert/registry";

export async function registerCommand(argv: string[], ctx?: { ledger?: unknown }): Promise<number> {
  if (argv.includes("--keygen")) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    process.stdout.write("VEKREVERT_SIGNING_KEY (private)\n");
    process.stdout.write(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    process.stdout.write("\n");
    process.stdout.write("VEKREVERT_VERIFY_KEY (public)\n");
    process.stdout.write(publicKey.export({ type: "spki", format: "pem" }).toString());
    return 0;
  }

  const dryRun = argv.includes("--dry-run");
  const signFlag = argv.includes("--sign");
  const force = argv.includes("--force");
  const paths = argv.filter((a) => !a.startsWith("-"));
  if (paths.length === 0) {
    process.stderr.write("usage: vekrevert register <path...> [--dry-run] [--sign] [--force] [--keygen]\n");
    return 2;
  }

  const loaded: ActionSignature[] = [];
  for (const p of paths) {
    try {
      loaded.push(await loadManifest(p));
    } catch (err) {
      process.stderr.write(`VR3005 schema_invalid: ${err instanceof Error ? err.message : String(err)}\n`);
      return 3;
    }
  }

  if (signFlag) {
    const pem = process.env.VEKREVERT_SIGNING_KEY;
    if (!pem) {
      process.stderr.write("usage: --sign requires VEKREVERT_SIGNING_KEY\n");
      return 2;
    }
    for (const m of loaded) {
      m.signature = signManifest(m, pem);
    }
  }

  const gated = [];
  for (const m of loaded) {
    const g = await gateManifest(m);
    if (!g.ok) {
      process.stderr.write(`${g.error_code} ${g.detail}\n`);
      return g.error_code.startsWith("VR4") ? 4 : 3;
    }
    gated.push(g);
  }

  if (dryRun) {
    for (const g of gated) {
      process.stdout.write(JSON.stringify(g.plan, null, 2) + "\n");
    }
    return 0;
  }

  const registry = new CompensatorRegistry({ ledger: ctx?.ledger });
  await registry.hydrate();
  const result = await registry.register(
    gated.map((g) => g.signature),
    { force },
  );
  if (!result.ok) {
    process.stderr.write(`${result.error_code ?? "VR3005"} ${result.detail ?? "register failed"}\n`);
    return 3;
  }
  process.stdout.write(`registered ${result.ids.join(" ")}\n`);
  return 0;
}

export async function loadManifest(path: string): Promise<ActionSignature> {
  const abs = resolve(path);
  if (path.endsWith(".ts") || path.endsWith(".js") || path.endsWith(".mjs")) {
    const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
    return coerceManifest((mod.default ?? mod.manifest ?? mod) as Record<string, unknown>);
  }
  const text = preprocessCompensatorYaml(readFileSync(abs, "utf8"));
  const raw = path.endsWith(".json") ? (JSON.parse(text) as unknown) : parseYaml(text);
  return coerceManifest(raw as Record<string, unknown>);
}

/** SPEC §6.5 writes `Authorization: Bearer { $ref: "..." }` which is not valid YAML. */
export function preprocessCompensatorYaml(text: string): string {
  return text.replace(
    /^(\s*[\w-]+\s*:\s*)(Bearer|Basic|Token)\s+\{\s*\$ref:\s*"([^"]+)"\s*\}\s*$/gm,
    (_m, prefix: string, scheme: string, ref: string) => `${prefix}{ ${scheme}: { $ref: "${ref}" } }`,
  );
}

export function coerceManifest(raw: Record<string, unknown>): ActionSignature {
  const match = (raw.match ?? {}) as Record<string, unknown>;
  if (typeof match.kind === "string") match.kind = match.kind;
  if (typeof match.method === "string") match.method = match.method.toUpperCase();
  if (typeof match.statement === "string") match.statement = match.statement.toUpperCase();
  const source = (raw.source as ActionSignature["source"]) ?? "registered";
  return {
    ...(raw as unknown as ActionSignature),
    match: match as ActionSignature["match"],
    binds: (raw.binds as ActionSignature["binds"]) ?? {},
    source,
  };
}

void isPlanRejection;
