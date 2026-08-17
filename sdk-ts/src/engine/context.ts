/** Compensation AsyncLocalStorage (D11 layer 1). Interceptors check this first. */

import { AsyncLocalStorage } from "node:async_hooks";

export interface CompensationContext {
  attempt_id: string;
}

const als = new AsyncLocalStorage<CompensationContext>();

export function getCompensationContext(): CompensationContext | undefined {
  return als.getStore();
}

export function runWithCompensationContext<T>(attempt_id: string, fn: () => Promise<T> | T): Promise<T> | T {
  return als.run({ attempt_id }, fn);
}
