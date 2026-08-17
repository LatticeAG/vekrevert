/** HTTP-only interceptor helper. Stamps capture.fidelity http_only. A proxy-captured fs write is T4 not T2 (D5). */

import type { ActionRef, JsonValue } from "@latticeag/vekrevert-core";
import { closeEffect, openEffect, type EffectHost } from "../effect.ts";

export interface ProxyRequestSpec<T> {
  action: ActionRef;
  args: JsonValue;
  run: () => Promise<T> | T;
}

/**
 * Wrap a proxy-observed call. No fs/SQL preimage is available, so fs writes classify as T4.
 */
export async function wrapProxyRequest<T>(host: EffectHost, spec: ProxyRequestSpec<T>): Promise<T> {
  const sagaId = host.currentSagaId;
  if (!sagaId || !host.ledgerHandle) return await spec.run();
  const opened = await openEffect(host, sagaId, {
    action: spec.action,
    args: spec.args,
    run: async () => spec.run(),
    capture: { fidelity: "http_only", interceptor: "lexgateway" },
  });
  try {
    const value = await spec.run();
    await closeEffect(host, opened, { value: value as never, result: value as never });
    return value;
  } catch (err) {
    try {
      await closeEffect(host, opened, { error: err });
    } catch {
      /* isolation */
    }
    throw err;
  }
}
