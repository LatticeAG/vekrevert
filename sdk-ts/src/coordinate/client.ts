/** Coordinator client: lease proxy + conflict RPC. Unset coordinatorUrl is a no-op. */

import { canonicalize, VekRevertError, type JsonValue } from "@latticeag/vekrevert-core";
import { hostedAuthHeaders, joinLedgerUrl, openHttpLedger } from "../ledger/http.ts";
import type { Ledger, LeaseAcquireOpts } from "../ledger/types.ts";
import type { ConflictVerdict } from "./store.ts";

export interface CoordinatorClientOpts {
  fetch?: typeof fetch;
  apiKey?: string;
}

export interface SubmitConflictInput {
  resource_key: string;
  holder: string;
  fence: number;
  saga_id: string;
  plan_hash: string;
  error_code?: string;
  commit?: boolean;
  phase?: "intent" | "commit";
}

export function resolveCoordinatorUrl(explicit?: string): string | undefined {
  const raw = explicit !== undefined ? explicit : process.env.VEKREVERT_COORDINATOR_URL;
  const v = raw?.trim();
  return v ? v : undefined;
}

export function attachCoordinatorLeases(
  ledger: Ledger,
  coordinatorUrl: string,
  opts: CoordinatorClientOpts = {},
): Ledger {
  const remote = openHttpLedger(coordinatorUrl, { fetch: opts.fetch, apiKey: opts.apiKey });
  return {
    ...ledger,
    async acquireLease(resourceKey, holder, leaseOpts?: LeaseAcquireOpts) {
      return remote.acquireLease(resourceKey, holder, leaseOpts);
    },
    async releaseLease(resourceKey, holder, fence) {
      return remote.releaseLease(resourceKey, holder, fence);
    },
    async getLease(resourceKey) {
      return remote.getLease(resourceKey);
    },
    async renewLease(resourceKey, holder, fence, leaseOpts?: LeaseAcquireOpts) {
      return remote.renewLease(resourceKey, holder, fence, leaseOpts);
    },
    async close() {
      await remote.close().catch(() => undefined);
      await ledger.close();
    },
  };
}

export const withCoordinatorLeases = attachCoordinatorLeases;

function asClientOpts(opts?: CoordinatorClientOpts | typeof fetch): CoordinatorClientOpts {
  if (typeof opts === "function") return { fetch: opts };
  return opts ?? {};
}

export async function submitConflict(
  coordinatorUrl: string,
  input: SubmitConflictInput,
  opts?: CoordinatorClientOpts | typeof fetch,
): Promise<ConflictVerdict> {
  const client = asClientOpts(opts);
  const fetchFn = client.fetch ?? globalThis.fetch;
  if (!fetchFn) throw new VekRevertError("VR5005", "coordinator has no fetch");
  const headers: Record<string, string> = { ...hostedAuthHeaders(), "content-type": "application/json" };
  const key = client.apiKey ?? process.env.VEKREVERT_API_KEY;
  if (key) headers.authorization = `Bearer ${key}`;
  const body: SubmitConflictInput = {
    ...input,
    commit: input.commit === true || input.phase === "commit",
  };
  let res: Response;
  try {
    res = await fetchFn(joinLedgerUrl(coordinatorUrl, "/conflicts"), {
      method: "POST",
      headers,
      body: canonicalize(body as unknown as JsonValue),
    });
  } catch (err) {
    throw new VekRevertError("VR5005", `coordinator unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = (await res.json().catch(() => ({}))) as ConflictVerdict & { error_code?: string };
  if (res.status === 409 || parsed.error_code === "VR5005") throw new VekRevertError("VR5005", "lease_unavailable");
  if (res.status === 412 || parsed.error_code === "VR5010") throw new VekRevertError("VR5010", "fenced");
  if (!res.ok) throw new VekRevertError("VR5005", `coordinator conflict refused: ${res.status}`);
  const verdict =
    parsed.verdict === "winner" || parsed.verdict === "loser" || parsed.verdict === "in_doubt" ? parsed.verdict : "in_doubt";
  return { ...parsed, verdict, resource_key: parsed.resource_key ?? input.resource_key };
}
