#!/usr/bin/env tsx
/** Emit an Ed25519 PEM keypair for hosted registry signing. Never hardcode the output. */

import { generateKeyPairSync } from "node:crypto";

export function generateManifestKeypair(): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function formatKeypair(pair: { privateKey: string; publicKey: string }): string {
  return [
    "# VEKREVERT_SIGNING_KEY (private; env-only; never commit)",
    pair.privateKey.trim(),
    "",
    "# VEKREVERT_VERIFY_KEY (public)",
    pair.publicKey.trim(),
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("keygen.ts")) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    process.stdout.write(
      [
        "vekrevert keygen - emit an Ed25519 PEM keypair for hosted registry signing",
        "",
        "Usage:",
        "  pnpm exec tsx scripts/keygen.ts [--help]",
        "",
        "Output (env-only; never commit):",
        "  VEKREVERT_SIGNING_KEY  private key (pkcs8 PEM)",
        "  VEKREVERT_VERIFY_KEY   public key (spki PEM)",
        "",
      ].join("\n"),
    );
    process.exit(0);
  }
  process.stdout.write(formatKeypair(generateManifestKeypair()));
}
