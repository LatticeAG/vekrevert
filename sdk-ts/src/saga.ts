/** Saga open/resume and SagaHandle.effect: openEffect -> run -> closeEffect. */
import {
  SDK_VERSION,
  type ActionRef,
  type ActionSignature,
  type JsonValue,
  type UndoOptions,
  type UndoReport,
  type VekRevertConfig,
} from "@latticeag/vekrevert-core";
import { openLedger } from "./ledger/open.ts";
import type { Ledger } from "./ledger/types.ts";
import { newSagaId } from "./ulid.ts";
import {
  appendChained,
  closeEffect,
  openEffect,
  reconcileOpenedAsInDoubt,
  type EffectHost,
  type EffectSpec,
} from "./effect.ts";
import type { CompensatorRegistry } from "./registry.ts";

export interface SagaHandle {
  readonly id: string;
  effect<R>(spec: {
    action: ActionRef;
    args: JsonValue;
    run: () => Promise<R>;
    signature?: Partial<ActionSignature>;
    capturePreimage?: EffectSpec["capturePreimage"];
  }): Promise<R>;
  close(): Promise<void>;
  undo(opts?: UndoOptions): Promise<UndoReport>;
}

export interface VekRevertLike {
  config: VekRevertConfig;
  ledgerHandle?: Ledger;
  captureFailures: number;
  version: string;
  undo: (sagaId: string, opts?: UndoOptions) => Promise<UndoReport>;
  registry?: CompensatorRegistry;
}

export async function ensureLedger(vr: VekRevertLike): Promise<Ledger> {
  if (vr.ledgerHandle) return vr.ledgerHandle;
  vr.ledgerHandle = await openLedger(vr.config.ledger, {
    ...vr.config.ledgerOpts,
    coordinatorUrl: vr.config.coordinatorUrl,
    fetch: (vr as { fetch?: typeof fetch }).fetch,
  });
  return vr.ledgerHandle;
}

function hostOf(vr: VekRevertLike): EffectHost {
  return vr;
}

function createHandle(vr: VekRevertLike, sagaId: string): SagaHandle {
  return {
    id: sagaId,
    async effect(spec) {
      const opened = await openEffect(hostOf(vr), sagaId, spec);
      try {
        const value = await spec.run();
        const closed = await closeEffect(hostOf(vr), opened, { value, result: value });
        return (closed.value ?? value) as Awaited<ReturnType<typeof spec.run>>;
      } catch (err) {
        if (opened.recorded) {
          try {
            await closeEffect(hostOf(vr), opened, { error: err, result: undefined });
          } catch {
            /* run's error is the one that must surface */
          }
        }
        throw err;
      }
    },
    async close() {
      const ledger = vr.ledgerHandle;
      if (!ledger) return;
      const saga = await ledger.getSaga(sagaId);
      if (saga && saga.status === "open") {
        saga.status = "closed";
        saga.closed_at = new Date().toISOString();
        await ledger.upsertSaga(saga);
      }
    },
    async undo(opts) {
      return vr.undo(sagaId, opts);
    },
  };
}

export async function openSaga(
  vr: VekRevertLike,
  opts?: { key?: string; agentId?: string },
): Promise<SagaHandle> {
  await ensureLedger(vr);
  const sagaId = newSagaId();
  await appendChained(
    vr.ledgerHandle!,
    sagaId,
    "saga_opened",
    {
      ...(opts?.key ? { key: opts.key } : {}),
      ...(opts?.agentId ?? vr.config.agentId ? { agent_id: opts?.agentId ?? vr.config.agentId } : {}),
      sdk_version: SDK_VERSION,
    },
    hostOf(vr),
  );
  (vr as VekRevertLike & { currentSagaId?: string }).currentSagaId = sagaId;
  return createHandle(vr, sagaId);
}

export async function resumeSaga(
  vr: VekRevertLike,
  sagaId: string,
  opts?: { restoreBoundary?: boolean },
): Promise<SagaHandle> {
  const ledger = await ensureLedger(vr);
  const saga = await ledger.getSaga(sagaId);
  if (!saga) throw new Error(`saga not found: ${sagaId}`);
  if (opts?.restoreBoundary) {
    await appendChained(
      ledger,
      sagaId,
      "restore_boundary",
      { prior_seq: Math.max(0, saga.next_seq - 1) },
      hostOf(vr),
    );
  }
  await reconcileOpenedAsInDoubt(hostOf(vr), sagaId);
  (vr as VekRevertLike & { currentSagaId?: string }).currentSagaId = sagaId;
  return createHandle(vr, sagaId);
}

export function attachSagaMethods(vr: VekRevertLike & {
  openSaga: (opts?: { key?: string; agentId?: string }) => Promise<SagaHandle>;
  resumeSaga: (sagaId: string, opts?: { restoreBoundary?: boolean }) => Promise<SagaHandle>;
}): void {
  vr.openSaga = (opts) => openSaga(vr, opts);
  vr.resumeSaga = (sagaId, opts) => resumeSaga(vr, sagaId, opts);
}
