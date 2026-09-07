/** Verification gate policy: config + env, cache TTL, per-saga budget. */

import {
  type VerificationMode,
  type VerificationPolicy,
  type VerificationRecord,
  type VekRevertConfig,
} from "@latticeag/vekrevert-core";

export const DEFAULT_VERIFICATION_MODE: VerificationMode = "audit";

export interface ResolvedVerificationPolicy {
  mode: VerificationMode;
  model?: string;
  budgetPerSaga?: number;
  cacheTtlMs?: number;
}

const verificationBudget = new Map<string, number>();

export function getVerificationBudget(): Map<string, number> {
  return verificationBudget;
}

export function envVerificationMode(env: NodeJS.ProcessEnv = process.env): VerificationMode | undefined {
  const raw = env.VEKREVERT_VERIFICATION_MODE?.trim().toLowerCase();
  if (raw === "off" || raw === "audit" || raw === "enforce") return raw;
  return undefined;
}

function envInt(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[name];
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function resolveVerificationPolicy(
  config?: Pick<VekRevertConfig, "verification" | "models">,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedVerificationPolicy {
  const fromConfig: VerificationPolicy = config?.verification ?? {};
  const mode = envVerificationMode(env) ?? fromConfig.mode ?? DEFAULT_VERIFICATION_MODE;
  const model =
    env.VEKREVERT_VERIFICATION_MODEL ??
    fromConfig.model ??
    config?.models?.verifier?.model ??
    undefined;
  const budgetPerSaga = envInt("VEKREVERT_VERIFICATION_BUDGET", env) ?? fromConfig.budgetPerSaga;
  const cacheTtlMs = envInt("VEKREVERT_VERIFICATION_CACHE_TTL", env) ?? fromConfig.cacheTtl;
  return {
    mode,
    model: model || undefined,
    budgetPerSaga: budgetPerSaga != null && budgetPerSaga >= 0 ? budgetPerSaga : undefined,
    cacheTtlMs: cacheTtlMs != null && cacheTtlMs >= 0 ? cacheTtlMs : undefined,
  };
}

export function cachedVerificationWithTtl(
  cache: Map<string, VerificationRecord>,
  planHash: string,
  now: Date,
  cacheTtlMs?: number,
): VerificationRecord | undefined {
  const hit = cache.get(planHash);
  if (!hit || hit.plan_hash !== planHash) return undefined;
  if (cacheTtlMs == null) return hit;
  const at = Date.parse(hit.verified_at);
  if (!Number.isFinite(at)) return undefined;
  if (now.getTime() - at > cacheTtlMs) return undefined;
  return hit;
}

/** Returns true if a remote/model invocation is still allowed for this saga. */
export function takeVerificationBudget(
  sagaId: string,
  budgetPerSaga: number | undefined,
  state: Map<string, number> = verificationBudget,
): boolean {
  if (budgetPerSaga == null) return true;
  const used = state.get(sagaId) ?? 0;
  if (used >= budgetPerSaga) return false;
  state.set(sagaId, used + 1);
  return true;
}
