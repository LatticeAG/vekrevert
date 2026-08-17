/** wrapFetch: classify + openEffect + closeEffect around fetch. Fidelity full (D5, D11). */

import {
  classifyLocality,
  type ActionRef,
  type JsonValue,
} from "@latticeag/vekrevert-core";
import { getCompensationContext } from "../engine/context.ts";
import { closeEffect, openEffect, type EffectHost } from "../effect.ts";

function headerRecord(init?: HeadersInit | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (typeof (init as Headers).forEach === "function" && !Array.isArray(init)) {
    (init as Headers).forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(init)) {
    for (const [k, v] of init) out[k] = v;
    return out;
  }
  for (const [k, v] of Object.entries(init as Record<string, string>)) out[k] = v;
  return out;
}

function parseBody(body: BodyInit | null | undefined): JsonValue {
  if (body == null) return null;
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as JsonValue;
    } catch {
      return body;
    }
  }
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof body === "object" && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
    try {
      return JSON.parse(JSON.stringify(body)) as JsonValue;
    } catch {
      return String(body);
    }
  }
  return "[binary]";
}

function parseInput(input: RequestInfo | URL, init?: RequestInit): {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: JsonValue;
} {
  if (input instanceof Request) {
    const method = (init?.method ?? input.method ?? "GET").toUpperCase();
    const url = input.url;
    const headers = { ...headerRecord(input.headers), ...headerRecord(init?.headers) };
    return { method, url, headers, body: parseBody(init?.body ?? null) };
  }
  const url = typeof input === "string" ? input : String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  return { method, url, headers: headerRecord(init?.headers), body: parseBody(init?.body) };
}

function withCompensationHeader(init: RequestInit | undefined, attemptId: string): RequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has("X-VekRevert-Compensation")) headers.set("X-VekRevert-Compensation", attemptId);
  return { ...init, headers };
}

function actionFrom(method: string, url: string, internalHosts?: string[]): ActionRef {
  let host = url;
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname;
  } catch {
    /* keep raw */
  }
  const loc = classifyLocality(host, internalHosts);
  return {
    kind: "http",
    name: `http.${method}.${host}${path}`,
    target: host,
    locality: loc.locality,
  };
}

async function observedFromResponse(res: Response): Promise<{ status: number; headers: Record<string, string>; body: JsonValue }> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  let body: JsonValue = null;
  try {
    const text = await res.clone().text();
    try {
      body = JSON.parse(text) as JsonValue;
    } catch {
      body = text;
    }
  } catch {
    body = null;
  }
  return { status: res.status, headers, body };
}

export function wrapFetch(host: EffectHost, f: typeof fetch): typeof fetch {
  const wrapped: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const ctx = getCompensationContext();
    let nextInput: RequestInfo | URL = input;
    let nextInit = init;
    if (ctx) {
      if (input instanceof Request) {
        const h = new Headers(input.headers);
        if (!h.has("X-VekRevert-Compensation")) h.set("X-VekRevert-Compensation", ctx.attempt_id);
        nextInput = new Request(input, { headers: h });
      } else {
        nextInit = withCompensationHeader(init, ctx.attempt_id);
      }
    }

    const parsed = parseInput(nextInput, nextInit);
    const sagaId = host.currentSagaId;
    if (!sagaId || !host.ledgerHandle) {
      return f(nextInput as never, nextInit);
    }

    const action = actionFrom(parsed.method, parsed.url, host.config.internalHosts);
    const args: JsonValue = {
      method: parsed.method,
      url: parsed.url,
      headers: parsed.headers,
      body: parsed.body,
    };

    const opened = await openEffect(host, sagaId, {
      action,
      args,
      run: async () => null,
      capture: { fidelity: "full", interceptor: "wrapFetch" },
    });
    try {
      const res = await f(nextInput as never, nextInit);
      const observed = await observedFromResponse(res);
      await closeEffect(host, opened, { value: observed, result: observed });
      return res;
    } catch (err) {
      try {
        await closeEffect(host, opened, { error: err });
      } catch {
        /* isolation */
      }
      throw err;
    }
  }) as typeof fetch;
  return wrapped;
}
