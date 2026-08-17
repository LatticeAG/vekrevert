/** @latticeag/vekrevert - public SDK. Phase 0: types + not_implemented bodies. */
import {
  SDK_VERSION,
  classifyAction,
  compilePlan,
  isPlanRejection,
  verifyChain,
  type ActionRef,
  type ActionSignature,
  type Actor,
  type ChainableEvent,
  type ClassificationRecord,
  type CompensationPlan,
  type Escalation,
  type EscalationReasonCode,
  type ExecuteResult,
  type JsonValue,
  type PlanRejection,
  type ReceiptsReport,
  type Saga,
  type SagaStatus,
  type UndoOptions,
  type UndoReport,
  type VekRevertConfig,
  type VerificationRecord,
  VekRevertError,
} from "@latticeag/vekrevert-core";
import { openMemoryLedger } from "./ledger/memory.ts";
import { openLedger } from "./ledger/open.ts";
import type { Ledger } from "./ledger/types.ts";
import { openSaga, resumeSaga, type SagaHandle } from "./saga.ts";
import { CompensatorRegistry } from "./registry.ts";
import { createCredentialProvider } from "./credentials.ts";
import { projectionToReceipt, openEffect, closeEffect } from "./effect.ts";
import { builtins, lowerSteps } from "@latticeag/vekrevert-compensators";
import { executePlan } from "./engine/execute.ts";
import { undoSaga } from "./engine/undo.ts";
import { probeEffect } from "./engine/probe.ts";
import { raise as raiseEscalation, onResume as resumeEscalation } from "./escalate/vekinbox.ts";
import { wrapFetch as wrapFetchImpl } from "./capture/http.ts";
import { instrumentFs as instrumentFsImpl } from "./capture/fs.ts";
import { instrumentPg as instrumentPgImpl, instrumentSqlite as instrumentSqliteImpl } from "./capture/sql.ts";
import { wrapMcpServer as wrapMcpServerImpl } from "./capture/mcp.ts";
import type { ExecutePlanOpts } from "./engine/execute.ts";
import type { UndoEngineOpts } from "./engine/undo.ts";
import type { StepDbHandle } from "./engine/step.ts";

export { defineConfig } from "./config.ts";
export { openLedger, parseLedgerUrl, DEFAULT_SQLITE_PATH } from "./ledger/open.ts";
export type { Ledger, LedgerKind, LedgerOpenOptions } from "./ledger/types.ts";
export { ulid, newSagaId, newEventId, newPlanId, newAttemptId, newEscalationId } from "./ulid.ts";
export type { VekRevertConfig };
export { attachSagaMethods, openSaga, resumeSaga } from "./saga.ts";
export type { SagaHandle };
export { openEffect, closeEffect, reconcileOpenedAsInDoubt, projectionToReceipt } from "./effect.ts";
export { executeStep } from "./engine/step.ts";
export type { StepContext, StepResult, StepDbHandle } from "./engine/step.ts";
export { executePlan, getCompensationContext, runWithCompensationContext } from "./engine/execute.ts";
export type { ExecutePlanOpts, CompensationContext } from "./engine/execute.ts";
export { undoSaga, transition } from "./engine/undo.ts";
export type { UndoEngineOpts } from "./engine/undo.ts";
export { acquireAll, assertFences, releaseAll, inspectFence, heartbeatAll } from "./engine/lease.ts";
export type { HeldLeases, AcquireAllOpts } from "./engine/lease.ts";
export { probeEffect, probeOnce } from "./engine/probe.ts";
export type { ProbeOpts, ProbeResult } from "./engine/probe.ts";
export { stepIdempotencyKey, lookupAttempt } from "./engine/idempotency.ts";
export { raise, onResume, WEBHOOK_MAX_TIMESTAMP_SKEW_MS, listStoredEscalations, getStoredEscalation } from "./escalate/vekinbox.ts";
export { wrapFetch } from "./capture/http.ts";
export { instrumentFs } from "./capture/fs.ts";
export { instrumentPg, instrumentSqlite } from "./capture/sql.ts";
export { wrapMcpServer } from "./capture/mcp.ts";
export { wrapProxyRequest } from "./proxy/lexgateway.ts";
export { preflightPolicy } from "./effect.ts";
export { redactArgs } from "./redact.ts";
export { putPreimage } from "./preimage/store.ts";

function ni(): never {
  throw new Error("not_implemented");
}

export class VekRevert {
  readonly config: VekRevertConfig;
  readonly version = SDK_VERSION;
  ledgerHandle?: Ledger;
  captureFailures = 0;
  readonly registry: CompensatorRegistry;
  readonly credentials: ReturnType<typeof createCredentialProvider>;
  fetch?: typeof fetch;
  db?: StepDbHandle;
  mcpCall?: ExecutePlanOpts["mcpCall"];
  injectProbe?: ExecutePlanOpts["probe"];
  currentSagaId?: string;

  constructor(config: VekRevertConfig) {
    this.config = {
      ...config,
      allowDrafted: config.allowDrafted === true,
      policy: { blockT4: false, ...config.policy },
    };
    if (config.ledger === "memory" || config.ledger.startsWith("memory:")) {
      openMemoryLedger();
    }
    this.registry = new CompensatorRegistry();
    this.credentials = createCredentialProvider(config.credentials);
    void this.registry.register(builtins, { force: true });
    const extra = (config.compensators ?? []).filter((c): c is ActionSignature => typeof c !== "string");
    if (extra.length) void this.registry.register(extra, { force: true });
  }

  async openLedgerHandle(): Promise<Ledger> {
    this.ledgerHandle = await openLedger(this.config.ledger, this.config.ledgerOpts);
    return this.ledgerHandle;
  }

  async openSaga(opts?: { key?: string; agentId?: string }): Promise<SagaHandle> {
    return openSaga(this, opts);
  }
  async resumeSaga(sagaId: string, opts?: { restoreBoundary?: boolean }): Promise<SagaHandle> {
    return resumeSaga(this, sagaId, opts);
  }

  classify(action: ActionRef, args: JsonValue): ClassificationRecord {
    return classifyAction(action, args, {
      writableRoots: this.config.writableRoots,
      internalHosts: this.config.internalHosts,
    });
  }
  async plan(effectId: string, opts?: { allowDrafted?: boolean }): Promise<CompensationPlan | PlanRejection> {
    if (opts?.allowDrafted) {
      return { ok: false, error_code: "VR4005", stage: "drafted", detail: "drafted compensations are disabled until Phase 8" };
    }
    const ledger = this.ledgerHandle ?? (await this.openLedgerHandle());
    const row = await ledger.getEffect(effectId);
    if (!row) {
      return { ok: false, error_code: "VR3001", stage: "compile", detail: `unknown effect ${effectId}` };
    }
    const receipt = projectionToReceipt(row);
    const matched = this.registry.match(receipt.action, receipt.args_observed, receipt.result_observed);
    if (!matched.matched) {
      return { ok: false, error_code: "VR3001", stage: "compile", detail: "no compensator match" };
    }
    const lowered = lowerSteps(matched.matched, receipt);
    const compiled = compilePlan(receipt, matched.matched, {
      origin: matched.matched.source,
      ...(lowered ? { steps: lowered.steps } : {}),
    });
    if (!isPlanRejection(compiled)) {
      try {
        await ledger.putPlan(compiled);
      } catch {
        /* plan persistence is best-effort for memory+sql */
      }
    }
    return compiled;
  }
  async verify(_planId: string): Promise<VerificationRecord> {
    return ni();
  }
  async execute(planId: string, opts?: { actor?: Actor; dryRun?: boolean } & Partial<ExecutePlanOpts>): Promise<ExecuteResult> {
    const ledger = this.ledgerHandle ?? (await this.openLedgerHandle());
    let plan = await ledger.getPlan(planId);
    if (!plan) {
      const compiled = await this.plan(planId);
      if (isPlanRejection(compiled)) throw new VekRevertError(compiled.error_code, compiled.detail);
      plan = compiled;
    }
    return executePlan(plan, {
      ledger,
      host: this,
      registry: this.registry,
      actor: opts?.actor,
      dryRun: opts?.dryRun,
      fetch: opts?.fetch ?? this.fetch,
      db: opts?.db ?? this.db,
      mcpCall: opts?.mcpCall ?? this.mcpCall,
      credentials: this.credentials,
      lease: opts?.lease ?? this.config.lease,
      allowDrafted: this.config.allowDrafted,
      probe: opts?.probe ?? this.injectProbe,
      sleep: opts?.sleep,
      heldLeases: opts?.heldLeases,
      skipAcquire: opts?.skipAcquire,
      now: opts?.now,
    });
  }

  async undo(sagaId: string, opts?: UndoOptions & Partial<UndoEngineOpts>): Promise<UndoReport> {
    const ledger = this.ledgerHandle ?? (await this.openLedgerHandle());
    return undoSaga(sagaId, {
      ledger,
      host: this,
      registry: this.registry,
      toSeq: opts?.toSeq,
      dryRun: opts?.dryRun,
      continueOnFailure: opts?.continueOnFailure,
      allowDrafted: opts?.allowDrafted ?? this.config.allowDrafted,
      fetch: opts?.fetch ?? this.fetch,
      db: opts?.db ?? this.db,
      mcpCall: opts?.mcpCall ?? this.mcpCall,
      credentials: this.credentials,
      lease: opts?.lease ?? this.config.lease,
      sleep: opts?.sleep,
      probe: opts?.probe ?? this.injectProbe,
      probeOpts: opts?.probeOpts,
      now: opts?.now,
      haltOnFailure: opts?.haltOnFailure,
    });
  }
  async status(sagaId: string): Promise<SagaStatus> {
    const ledger = this.ledgerHandle ?? (await this.openLedgerHandle());
    const saga = await ledger.getSaga(sagaId);
    if (!saga) throw new VekRevertError("VR3001", `unknown saga ${sagaId}`);
    const rows = await ledger.listEffects(sagaId);
    const effects = rows.map(projectionToReceipt);
    const pending = effects.filter(
      (e) =>
        (e.status === "landed" || e.status === "in_doubt") &&
        !["compensated", "none_required", "superseded", "manually_resolved"].includes(e.compensation_state),
    ).length;
    const events = await ledger.readSaga(sagaId);
    const raised = events.filter((e) => e.type === "escalation_raised").length;
    const resolved = events.filter((e) => e.type === "escalation_resolved").length;
    return {
      saga,
      effects,
      pending,
      open_escalations: Math.max(0, raised - resolved),
      chain_head: saga.chain_head,
    };
  }
  async receipts(sagaId: string, opts?: { verifyChain?: boolean }): Promise<ReceiptsReport> {
    const ledger = this.ledgerHandle ?? (await this.openLedgerHandle());
    const events = await ledger.readSaga(sagaId);
    const report: ReceiptsReport = { saga_id: sagaId, events };
    if (opts?.verifyChain) {
      const result = verifyChain(events as unknown as ChainableEvent[]);
      if (result.ok) report.chain_ok = true;
      else {
        report.chain_ok = false;
        report.broken_at = result.brokenAt;
        report.reason = result.reason;
      }
    }
    return report;
  }
  async escalate(effectId: string, reason: EscalationReasonCode): Promise<Escalation> {
    const ledger = this.ledgerHandle ?? (await this.openLedgerHandle());
    const row = await ledger.getEffect(effectId);
    if (!row) throw new VekRevertError("VR3001", `unknown effect ${effectId}`);
    let plan = undefined;
    const compiled = await this.plan(effectId);
    if (!isPlanRejection(compiled)) plan = compiled;
    const { escalation_id } = await raiseEscalation({
      ledger,
      host: this,
      saga_id: row.saga_id,
      effect_id: effectId,
      reason_code: reason,
      plan,
      receipt: projectionToReceipt(row),
    });
    return {
      escalation_id,
      effect_id: effectId,
      saga_id: row.saga_id,
      reason_code: reason,
      status: "pending",
    };
  }

  async onResume(headers: Record<string, string>, rawBody: string) {
    const ledger = this.ledgerHandle ?? (await this.openLedgerHandle());
    return resumeEscalation(headers, rawBody, { host: this, ledger });
  }

  async probe(effectId: string, opts?: { probe?: ExecutePlanOpts["probe"] }) {
    const ledger = this.ledgerHandle ?? (await this.openLedgerHandle());
    const row = await ledger.getEffect(effectId);
    if (!row) throw new VekRevertError("VR3001", `unknown effect ${effectId}`);
    return probeEffect(projectionToReceipt(row), {
      probe: opts?.probe ?? this.injectProbe,
      fetch: this.fetch,
      db: this.db as never,
    });
  }

  wrapFetch(f: typeof fetch): typeof fetch {
    return wrapFetchImpl(this, f);
  }
  wrapMcpServer(server: unknown): unknown {
    return wrapMcpServerImpl(this, server as never);
  }
  instrumentFs(opts?: { module?: typeof import("node:fs") }): Disposable {
    return instrumentFsImpl(this, opts);
  }
  instrumentPg(pool: unknown): Disposable {
    return instrumentPgImpl(this, pool as never);
  }
  instrumentSqlite(db: unknown): Disposable {
    return instrumentSqliteImpl(this, db as never);
  }
  wrapTool<A extends JsonValue, R>(
    name: string,
    fn: (a: A) => Promise<R>,
    sig?: Partial<ActionSignature>,
  ): (a: A) => Promise<R> {
    return async (a: A) => {
      const sagaId = this.currentSagaId;
      if (!sagaId || !this.ledgerHandle) return fn(a);
      const action: ActionRef = { kind: "sdk_fn", name, locality: "unknown" };
      const opened = await openEffect(this, sagaId, {
        action,
        args: a,
        signature: sig,
        capture: { fidelity: "tool_only", interceptor: "sdk-ts/tool" },
        run: async () => undefined as unknown as R,
      });
      try {
        const value = await fn(a);
        await closeEffect(this, opened, { value, result: value });
        return value;
      } catch (err) {
        if (opened.recorded) {
          try {
            await closeEffect(this, opened, { error: err, result: undefined });
          } catch {
            /* the tool's error is the one that must surface */
          }
        }
        throw err;
      }
    };
  }
}

export type { Saga };
export { VekRevertError, SDK_VERSION, openMemoryLedger };
