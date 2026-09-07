/** EP4 executePlan: leases, idempotency, ALS compensation context (D4, D11, §8.3). */

import {
  DEFAULT_LEASE,
  DEFAULT_LIMITS,
  VekRevertError,
  type Actor,
  type CompensationPlan,
  type CompensationStep,
  type EffectReceipt,
  type ExecuteResult,
  type JsonValue,
  type Postcondition,
  type VerificationMode,
  type VRCode,
} from "@latticeag/vekrevert-core";
import { appendChained, projectionToReceipt, type EffectHost } from "../effect.ts";
import {
  DuplicateAttemptError,
  isDuplicateAttempt,
  type AttemptRecord,
  type Ledger,
} from "../ledger/types.ts";
import type { CompensatorRegistry } from "../registry.ts";
import { newAttemptId } from "../ulid.ts";
import { raise } from "../escalate/sink.ts";
import {
  getCompensationContext as getAls,
  runWithCompensationContext as runAls,
  type CompensationContext,
} from "./context.ts";
import { lookupAttempt, stepIdempotencyKey } from "./idempotency.ts";
import {
  acquireAll,
  assertFences,
  heartbeatAll,
  inspectFence,
  releaseAll,
  sortedResourceKeys,
  type HeldLeases,
} from "./lease.ts";
import { probeEffect, type ProbeOpts } from "./probe.ts";
import { executeStep, type StepContext, type StepDbHandle, type StepResult } from "./step.ts";
import { executeGateRejection } from "../verify/verifier.ts";
import { resolveVerificationPolicy } from "../verify/policy.ts";
import { resolveCoordinatorUrl, submitConflict } from "../coordinate/client.ts";

export type { CompensationContext };
export { getAls as getCompensationContext, runAls as runWithCompensationContext };

const RETRYABLE = new Set<string>(["VR5001"]);

export interface ExecutePlanOpts {
  ledger: Ledger;
  host: EffectHost;
  actor?: Actor;
  dryRun?: boolean;
  allowDrafted?: boolean;
  fetch?: typeof fetch;
  db?: StepDbHandle;
  mcpCall?: StepContext["mcpCall"];
  credentials?: StepContext["credentials"];
  lease?: { ttlMs?: number; heartbeatMs?: number; waitMs?: number; pollMs?: number };
  holder?: string;
  processId?: string;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  registry?: CompensatorRegistry;
  writableRoots?: string[];
  permits?: string[];
  probe?: ProbeOpts["probe"];
  probeOpts?: ProbeOpts;
  heldLeases?: HeldLeases;
  skipAcquire?: boolean;
  signature?: StepContext["signature"];
  verificationMode?: VerificationMode;
}

function vrCode(err: unknown): VRCode | undefined {
  return err instanceof VekRevertError ? err.code : undefined;
}

function asVr(err: unknown, fallback: VRCode = "VR5001"): VekRevertError {
  if (err instanceof VekRevertError) return err;
  return new VekRevertError(fallback, err instanceof Error ? err.message : String(err));
}

function nowIso(opts: ExecutePlanOpts): string {
  return (opts.now ?? new Date()).toISOString();
}

async function loadReceipt(ledger: Ledger, effectId: string): Promise<EffectReceipt> {
  const row = await ledger.getEffect(effectId);
  if (!row) throw new VekRevertError("VR3001", `unknown effect ${effectId}`);
  return projectionToReceipt(row);
}

function checkPostconditions(plan: CompensationPlan, results: StepResult[]): void {
  for (const pc of plan.postconditions ?? []) {
    const r = results[pc.step_index];
    if (!r) {
      if (pc.required) throw new VekRevertError("VR5002", `postcondition unevaluable at ${pc.step_index}`);
      continue;
    }
    if (!evalPostcondition(pc, r)) {
      throw new VekRevertError("VR5002", pc.kind);
    }
  }
}

function evalPostcondition(pc: Postcondition, r: StepResult): boolean {
  switch (pc.kind) {
    case "http_status":
      if (typeof pc.expected === "number") return r.status === pc.expected;
      if (Array.isArray(pc.expected)) return r.status != null && (pc.expected as unknown[]).includes(r.status);
      return r.status != null && r.status >= 200 && r.status < 300;
    case "row_count": {
      const n = typeof pc.expected === "number" ? pc.expected : 1;
      return r.rowcount === n;
    }
    case "file_hash":
      return Boolean(r.sha256) || r.ok;
    case "file_absent":
      return r.absent === true || r.ok;
    case "tool_no_error":
      return r.ok;
    case "http_probe_absent":
      return r.ok === true || r.compensated_via_404 === true || r.status === 404 || (r.status != null && r.status >= 200 && r.status < 300);
    default:
      return r.ok;
  }
}

async function handleExistingAttempt(
  existing: AttemptRecord,
  plan: CompensationPlan,
  opts: ExecutePlanOpts,
  keys: string[],
  held: HeldLeases | undefined,
  step: CompensationStep,
  ctx: StepContext,
  index: number,
): Promise<{ result?: StepResult; skip: boolean; inDoubt?: boolean }> {
  if (existing.state === "succeeded") {
    return { skip: true, result: { ok: true, kind: step.kind } };
  }
  if (existing.state === "failed") {
    const retries = Number((existing.response_hash ?? "0").replace(/^[^\d]*/, "") || "0");
    if (existing.error_code && RETRYABLE.has(existing.error_code) && retries < (opts.host.config.limits?.maxCompensationRetries ?? DEFAULT_LIMITS.maxCompensationRetries)) {
      return { skip: false };
    }
    throw new VekRevertError((existing.error_code as VRCode) ?? "VR5001", "attempt already failed");
  }
  if (existing.state === "in_doubt") {
    return { skip: false, inDoubt: true };
  }
  if (existing.state === "started") {
    const key = keys[0];
    if (key && held) {
      const st = await inspectFence(key, held, opts.ledger);
      if (st === "ok") return { skip: false };
      if (st === "fenced" || st === "held_elsewhere") throw new VekRevertError("VR5010", key);
    }
    const waitMs = opts.lease?.waitMs ?? DEFAULT_LEASE.waitMs;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      const cur = await lookupAttempt(opts.ledger, existing.idempotency_key);
      if (cur?.state === "succeeded") return { skip: true, result: { ok: true, kind: step.kind } };
      if (cur?.state === "failed") throw new VekRevertError((cur.error_code as VRCode) ?? "VR5001");
      if (cur?.state === "in_doubt") return { skip: false, inDoubt: true };
      const lease = key ? await opts.ledger.getLease(key) : undefined;
      const n = nowIso(opts);
      if (lease && lease.expires_at <= n) return { skip: false, inDoubt: true };
      await sleep(Math.min(20, Math.max(1, waitMs)));
    }
    const latest = await lookupAttempt(opts.ledger, existing.idempotency_key);
    if (latest?.state === "succeeded") return { skip: true, result: { ok: true, kind: step.kind } };
    if (latest?.state === "failed") throw new VekRevertError((latest.error_code as VRCode) ?? "VR5001");
    const lease = key ? await opts.ledger.getLease(key) : undefined;
    if (lease && lease.expires_at > nowIso(opts) && lease.holder !== (held?.holder ?? opts.holder)) {
      throw new VekRevertError("VR5005", "lease still held");
    }
    return { skip: false, inDoubt: true };
  }
  void index;
  void ctx;
  void plan;
  return { skip: false };
}

export async function executePlan(plan: CompensationPlan, opts: ExecutePlanOpts): Promise<ExecuteResult> {
  const started = Date.now();
  const allowDrafted = opts.allowDrafted ?? opts.host.config.allowDrafted === true;
  if (plan.origin === "drafted" && !allowDrafted) {
    await raise({
      ledger: opts.ledger,
      host: opts.host,
      saga_id: plan.saga_id,
      effect_id: plan.effect_id,
      reason_code: "drafted_not_allowed",
      approval_binds_to: plan.plan_hash,
    });
    throw new VekRevertError("VR4005", "drafted_not_allowed");
  }
  const mode =
    opts.verificationMode ?? resolveVerificationPolicy(opts.host.config).mode;
  const gate = executeGateRejection(plan, mode);
  if (gate) {
    await raise({
      ledger: opts.ledger,
      host: opts.host,
      saga_id: plan.saga_id,
      effect_id: plan.effect_id,
      reason_code: "verifier_rejected",
      approval_binds_to: plan.plan_hash,
    });
    if (mode === "enforce") {
      throw new VekRevertError(gate.error_code, gate.detail);
    }
    return {
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      ok: false,
      postconditions_ok: false,
      attempt_ids: [],
      duration_ms: Date.now() - started,
      error_code: gate.error_code,
      reversal_completeness: plan.reversal_completeness,
      leak: plan.leak,
    };
  }

  const receipt = await loadReceipt(opts.ledger, plan.effect_id);
  const keys = sortedResourceKeys(receipt.resource_keys ?? []);

  if (receipt.tier === "T4" || plan.steps.some((s) => s.kind === "manual")) {
    const { escalation_id } = await raise({
      ledger: opts.ledger,
      host: opts.host,
      saga_id: plan.saga_id,
      effect_id: plan.effect_id,
      reason_code: "t4_irreversible",
      approval_binds_to: plan.plan_hash,
    });
    void escalation_id;
    return {
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      ok: false,
      postconditions_ok: false,
      attempt_ids: [],
      duration_ms: Date.now() - started,
      error_code: "VR1010",
      reversal_completeness: plan.reversal_completeness,
      leak: plan.leak,
    };
  }

  if (plan.cascade_risk === "high") {
    await raise({
      ledger: opts.ledger,
      host: opts.host,
      saga_id: plan.saga_id,
      effect_id: plan.effect_id,
      reason_code: "cascade_risk",
      approval_binds_to: plan.plan_hash,
    });
    return {
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      ok: false,
      postconditions_ok: false,
      attempt_ids: [],
      duration_ms: Date.now() - started,
      error_code: "VR1010",
      reversal_completeness: plan.reversal_completeness,
      leak: plan.leak,
    };
  }

  const ttlMs = opts.lease?.ttlMs ?? opts.host.config.lease?.ttlMs ?? DEFAULT_LEASE.ttlMs;
  const waitMs = opts.lease?.waitMs ?? opts.host.config.lease?.waitMs ?? DEFAULT_LEASE.waitMs;
  const heartbeatMs = opts.lease?.heartbeatMs ?? opts.host.config.lease?.heartbeatMs ?? DEFAULT_LEASE.heartbeatMs;
  const processId = opts.processId ?? String(process.pid);
  const runId = newAttemptId();
  const holder = opts.holder ?? `${processId}:${plan.saga_id}:${runId}`;

  let held: HeldLeases | undefined = opts.heldLeases;
  if (!opts.skipAcquire && !opts.heldLeases) {
    try {
      held = await acquireAll(keys, {
        ledger: opts.ledger,
        holder,
        ttlMs,
        waitMs,
        pollMs: opts.lease?.pollMs,
        sleep: opts.sleep,
      });
    } catch (err) {
      const code = vrCode(err);
      if (code === "VR5005") {
        await raise({
          ledger: opts.ledger,
          host: opts.host,
          saga_id: plan.saga_id,
          effect_id: plan.effect_id,
          reason_code: "lease_unavailable",
          approval_binds_to: plan.plan_hash,
        });
      }
      throw asVr(err, "VR5005");
    }
  }
  if (!held) held = { holder, fences: new Map(), expires_at: new Map() };

  if (opts.skipAcquire && opts.heldLeases) {
    await assertFences(keys, opts.heldLeases, opts.ledger, nowIso(opts));
  }

  if (opts.dryRun) {
    try {
      await releaseAll(keys, held, opts.ledger);
    } catch {
      /* dry-run still reports */
    }
    return {
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      ok: true,
      postconditions_ok: true,
      attempt_ids: [],
      duration_ms: Date.now() - started,
      reversal_completeness: plan.reversal_completeness,
      leak: plan.leak,
    };
  }

  const coordUrl = resolveCoordinatorUrl(opts.host.config.coordinatorUrl);

  const signature =
    opts.signature ??
    opts.registry?.match(receipt.action, receipt.args_observed, receipt.result_observed).matched ??
    undefined;

  const attemptIds: string[] = [];
  const results: StepResult[] = [];
  let beat: ReturnType<typeof setInterval> | undefined;
  if (keys.length && heartbeatMs > 0) {
    beat = setInterval(() => {
      void heartbeatAll(keys, held!, opts.ledger, ttlMs).catch(() => undefined);
    }, heartbeatMs);
    beat.unref?.();
  }

  try {
    if (coordUrl && keys.length && held) {
      for (const key of keys) {
        const verdict = await submitConflict(
          coordUrl,
          {
            resource_key: key,
            holder: held.holder,
            fence: held.fences.get(key) ?? 0,
            saga_id: plan.saga_id,
            plan_hash: plan.plan_hash,
            phase: "intent",
          },
          opts.fetch ?? opts.host.fetch,
        );
        if (verdict.verdict !== "winner") {
          await raise({
            ledger: opts.ledger,
            host: opts.host,
            saga_id: plan.saga_id,
            effect_id: plan.effect_id,
            reason_code: "compensation_failed",
            approval_binds_to: plan.plan_hash,
          });
          throw new VekRevertError("VR5005", `conflict_${verdict.verdict}`);
        }
      }
    }

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;
      const key = stepIdempotencyKey({
        saga_id: plan.saga_id,
        effect_seq: receipt.seq,
        compensator_id: plan.compensator_id,
        plan_hash: plan.plan_hash,
        step_index: i,
      });
      const attempt_id = newAttemptId();
      const fence = keys.length ? (held.fences.get(keys[0]!) ?? 0) : 0;
      const row: AttemptRecord = {
        attempt_id,
        idempotency_key: key,
        effect_id: plan.effect_id,
        plan_id: plan.plan_id,
        step_index: i,
        fence,
        state: "started",
        started_at: nowIso(opts),
      };

      const ctx: StepContext = {
        receipt,
        signature,
        attempt_id,
        ledger: opts.ledger,
        credentials: opts.credentials,
        db: opts.db,
        fetch: opts.fetch,
        mcpCall: opts.mcpCall,
        permits: opts.permits ?? signature?.permits,
        now: opts.now,
        writableRoots: opts.writableRoots ?? opts.host.config.writableRoots,
      };

      let existing: AttemptRecord | undefined;
      try {
        await opts.ledger.appendAttempt(row);
        existing = row;
      } catch (err) {
        if (!isDuplicateAttempt(err) && !(err instanceof DuplicateAttemptError)) throw err;
        existing = await lookupAttempt(opts.ledger, key);
        if (!existing) throw asVr(err);
        const handled = await handleExistingAttempt(existing, plan, opts, keys, held, step, ctx, i);
        if (handled.skip) {
          attemptIds.push(existing.attempt_id);
          results.push(handled.result ?? { ok: true, kind: step.kind });
          continue;
        }
        if (handled.inDoubt) {
          existing.state = "in_doubt";
          await opts.ledger.updateAttempt(existing);
          await appendChained(
            opts.ledger,
            plan.saga_id,
            "effect_in_doubt",
            { reason: "started_expired_lease", probe_scheduled: true } as unknown as JsonValue,
            opts.host,
            plan.effect_id,
          );
          const probed = await probeEffect(receipt, {
            ...(opts.probeOpts ?? {}),
            probe: opts.probe,
            fetch: opts.fetch,
            db: opts.db as ProbeOpts["db"],
            sleep: opts.sleep,
            backoffMs: opts.probeOpts?.backoffMs ?? [1, 1, 1],
          });
          await appendChained(
            opts.ledger,
            plan.saga_id,
            "effect_probed",
            { probe_result: probed, attempts: 3 } as unknown as JsonValue,
            opts.host,
            plan.effect_id,
          );
          if (probed === "unknown") {
            await raise({
              ledger: opts.ledger,
              host: opts.host,
              saga_id: plan.saga_id,
              effect_id: plan.effect_id,
              reason_code: "unresolved_in_doubt",
              approval_binds_to: plan.plan_hash,
            });
            throw new VekRevertError("VR2020", "unresolved_in_doubt");
          }
          if (probed === "not_landed") {
            existing.state = "failed";
            existing.finished_at = nowIso(opts);
            existing.error_code = "VR5001";
            await opts.ledger.updateAttempt(existing);
            attemptIds.push(existing.attempt_id);
            continue;
          }
          existing.state = "succeeded";
          existing.finished_at = nowIso(opts);
          await opts.ledger.updateAttempt(existing);
          attemptIds.push(existing.attempt_id);
          results.push({ ok: true, kind: step.kind });
          continue;
        }
        row.attempt_id = existing.attempt_id;
      }

      for (const rk of keys) {
        const st = await inspectFence(rk, held, opts.ledger, nowIso(opts));
        if (st === "fenced" || st === "held_elsewhere") throw new VekRevertError("VR5010", rk);
        if (st === "expired" || st === "missing") {
          row.state = "in_doubt";
          await opts.ledger.updateAttempt({ ...row, state: "in_doubt" });
          throw new VekRevertError("VR5010", rk);
        }
      }

      const maxRetries = opts.host.config.limits?.maxCompensationRetries ?? DEFAULT_LIMITS.maxCompensationRetries;
      let lastErr: unknown;
      let result: StepResult | undefined;
      for (let attemptN = 1; attemptN <= maxRetries; attemptN++) {
        try {
          result = await runAls(row.attempt_id, () => executeStep(step, { ...ctx, attempt_id: row.attempt_id }));
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          const code = vrCode(err);
          if (code === "VR5010" || code === "VR5009" || code === "VR5002" || code === "VR5007" || code === "VR4005") {
            break;
          }
          if (!code || !RETRYABLE.has(code) || attemptN >= maxRetries) break;
        }
      }

      if (lastErr) {
        const ve = asVr(lastErr);
        const finished: AttemptRecord = {
          ...row,
          state: "failed",
          finished_at: nowIso(opts),
          error_code: ve.code,
          response_hash: String(maxRetries),
        };
        await opts.ledger.updateAttempt(finished);
        attemptIds.push(row.attempt_id);
        throw ve;
      }

      const ok: AttemptRecord = {
        ...row,
        state: "succeeded",
        finished_at: nowIso(opts),
      };
      await opts.ledger.updateAttempt(ok);
      attemptIds.push(row.attempt_id);
      results.push(result ?? { ok: true, kind: step.kind });
    }

    checkPostconditions(plan, results);

    await appendChained(
      opts.ledger,
      plan.saga_id,
      "compensation_executed",
      {
        plan_hash: plan.plan_hash,
        attempt_ids: attemptIds,
        postconditions_ok: true,
        reversal_completeness: plan.reversal_completeness,
        leak: plan.leak,
        duration_ms: Date.now() - started,
        origin: plan.origin,
        fencing_token: held
          ? { holder: held.holder, fences: Object.fromEntries(held.fences) }
          : undefined,
      } as unknown as JsonValue,
      opts.host,
      plan.effect_id,
    );

    const firstKey = keys[0];
    if (coordUrl && firstKey && held) {
      await submitConflict(
        coordUrl,
        {
          resource_key: firstKey,
          holder: held.holder,
          fence: held.fences.get(firstKey) ?? 0,
          saga_id: plan.saga_id,
          plan_hash: plan.plan_hash,
          commit: true,
        },
        opts.fetch ?? opts.host.fetch,
      ).catch(() => undefined);
    }

    return {
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      ok: true,
      postconditions_ok: true,
      attempt_ids: attemptIds,
      duration_ms: Date.now() - started,
      reversal_completeness: plan.reversal_completeness,
      leak: plan.leak,
    };
  } catch (err) {
    const ve = asVr(err);
    if (ve.code === "VR5006") {
      const coordUrl = resolveCoordinatorUrl(opts.host.config.coordinatorUrl);
      const firstKey = keys[0];
      if (coordUrl && firstKey && held) {
        const verdict = await submitConflict(
          coordUrl,
          {
            resource_key: firstKey,
            holder: held.holder,
            fence: held.fences.get(firstKey) ?? 0,
            saga_id: plan.saga_id,
            plan_hash: plan.plan_hash,
            error_code: "VR5006",
          },
          opts.fetch ?? opts.host.fetch,
        ).catch(() => undefined);
        if (verdict?.verdict === "loser") {
          await raise({
            ledger: opts.ledger,
            host: opts.host,
            saga_id: plan.saga_id,
            effect_id: plan.effect_id,
            reason_code: "compensation_failed",
            approval_binds_to: plan.plan_hash,
          }).catch(() => undefined);
        }
      }
    }
    if (ve.code === "VR5002") {
      await appendChained(
        opts.ledger,
        plan.saga_id,
        "compensation_failed",
        {
          error_code: ve.code,
          step_index: Math.max(0, results.length),
          attempts: 1,
          postcondition_failed: true,
        } as unknown as JsonValue,
        opts.host,
        plan.effect_id,
      );
    } else if (ve.code !== "VR4005" && ve.code !== "VR2020") {
      await appendChained(
        opts.ledger,
        plan.saga_id,
        "compensation_failed",
        {
          error_code: ve.code,
          step_index: Math.max(0, results.length),
          attempts: 1,
          postcondition_failed: false,
        } as unknown as JsonValue,
        opts.host,
        plan.effect_id,
      );
    }
    throw ve;
  } finally {
    if (beat) clearInterval(beat);
    try {
      await releaseAll(keys, held, opts.ledger);
    } catch {
      /* fence mismatch on release is the new holder's problem */
    }
  }
}
