/** http_request. Credentials occupy header positions only. Sends X-VekRevert-Compensation (D11). */

import { isRef, VekRevertError, type CompensationStep, type JsonValue, type Ref } from "@latticeag/vekrevert-core";
import type { StepContext, StepResult } from "../step.ts";

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, JsonValue>;
  return {};
}

function stringify(v: JsonValue | undefined): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function headerValue(v: JsonValue | Ref | undefined, ctx: StepContext): string {
  if (isRef(v) && v.$ref.startsWith("credential.")) {
    const name = v.$ref.slice("credential.".length);
    const got = ctx.credentials?.resolve(name);
    if (got == null) throw new VekRevertError("VR5014", name);
    return got;
  }
  return stringify(v as JsonValue);
}

export async function executeHttp(step: CompensationStep, resolved: JsonValue, ctx: StepContext): Promise<StepResult> {
  if (step.kind !== "http_request") throw new VekRevertError("VR5001", `expected http_request, got ${step.kind}`);
  const rec = asRecord(resolved);
  const url = stringify(rec.url);
  if (!url) throw new VekRevertError("VR5001", "http url empty");
  const headers: Record<string, string> = {
    "X-VekRevert-Compensation": ctx.attempt_id,
  };
  const rawHeaders = asRecord(rec.headers);
  for (const [k, v] of Object.entries(rawHeaders)) {
    headers[k] = headerValue(v as JsonValue, ctx);
  }
  const init: RequestInit = { method: step.method, headers };
  if (rec.body !== undefined && rec.body !== null) {
    init.body = typeof rec.body === "string" ? rec.body : JSON.stringify(rec.body);
    if (!headers["content-type"] && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  }
  const fetchFn = ctx.fetch ?? fetch;
  const res = await fetchFn(url, init);
  const status = res.status;
  if (status === 404 && step.expect.treat_404_as_compensated) {
    return { ok: true, kind: "http_request", status, compensated_via_404: true };
  }
  if (!step.expect.status_in.includes(status)) {
    throw new VekRevertError("VR5001", `http status ${status}`);
  }
  return { ok: true, kind: "http_request", status };
}
