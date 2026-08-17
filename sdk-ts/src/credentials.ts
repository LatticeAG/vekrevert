/** Credential provider. Values never enter the ledger, logs, or plans (D13). */

import type { VekRevertConfig } from "@latticeag/vekrevert-core";

export interface CredentialProvider {
  readonly kind: "env" | "file" | "vault" | "awssm" | "custom";
  has(name: string): boolean;
  /** Resolve a secret. Callers must not log the return value. */
  resolve(name: string): string | undefined;
  names(): string[];
}

export function envCredentialProvider(map: Record<string, string> = {}): CredentialProvider {
  return {
    kind: "env",
    has(name: string): boolean {
      const envVar = map[name] ?? name;
      const v = process.env[envVar];
      return v != null && v !== "";
    },
    resolve(name: string): string | undefined {
      const envVar = map[name] ?? name;
      return process.env[envVar];
    },
    names(): string[] {
      return Object.keys(map);
    },
  };
}

export function createCredentialProvider(config?: VekRevertConfig["credentials"]): CredentialProvider {
  const map = config?.map ?? {};
  const provider = config?.provider ?? "env";
  if (provider === "env") return envCredentialProvider(map);
  throw new Error(`credential provider '${provider}' is not_implemented`);
}

export function credentialPresence(provider: CredentialProvider, names: string[]): Array<{ name: string; present: boolean }> {
  return names.map((name) => ({ name, present: provider.has(name) }));
}
