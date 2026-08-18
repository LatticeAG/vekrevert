/** LexShield adapter (D6). EP1 BLOCK/CHALLENGE when blockT4 is on; unreachable is fail-closed. */

import { spawn } from "node:child_process";
import { VekRevertError, type JsonValue } from "@latticeag/vekrevert-core";

export type LexShieldDecision = "ALLOW" | "BLOCK" | "CHALLENGE";

export type LexShieldOk = { ok: true; decision: LexShieldDecision };
export type LexShieldFail = {
  ok: false;
  status: "unconfigured" | "unreachable" | "timeout";
  detail: string;
};
export type LexShieldResult = LexShieldOk | LexShieldFail;

export interface LexShieldEvaluateInput {
  tool: string;
  args: unknown;
  pack?: string;
  url?: string;
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  cli?: boolean;
}

export interface LexShieldEnv {
  url?: string;
  token?: string;
  pack?: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

export function lexshieldEnv(): LexShieldEnv {
  const rawTimeout = process.env.LEXSHIELD_TIMEOUT_MS;
  const timeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_TIMEOUT_MS;
  return {
    url: process.env.LEXSHIELD_URL || undefined,
    token: process.env.LEXSHIELD_TOKEN || process.env.LEXSHIELD_API_KEY || undefined,
    pack: process.env.LEXSHIELD_PACK || undefined,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

export function lexshieldConfigured(url?: string): boolean {
  return Boolean(url ?? process.env.LEXSHIELD_URL);
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  const t = token ?? process.env.LEXSHIELD_TOKEN ?? process.env.LEXSHIELD_API_KEY;
  if (t) headers.authorization = `Bearer ${t}`;
  return headers;
}

function parseDecision(raw: unknown): LexShieldDecision | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const d = String(rec.decision ?? rec.verdict ?? rec.action ?? "").toUpperCase();
  if (d === "ALLOW" || d === "BLOCK" || d === "CHALLENGE") return d;
  return undefined;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("lexshield_timeout"), { code: "TIMEOUT" })), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function evaluateHttp(input: LexShieldEvaluateInput, env: LexShieldEnv): Promise<LexShieldResult> {
  const url = input.url ?? env.url;
  if (!url) return { ok: false, status: "unconfigured", detail: "LEXSHIELD_URL unset" };
  const fetchFn = input.fetch ?? globalThis.fetch;
  if (!fetchFn) return { ok: false, status: "unreachable", detail: "no fetch" };
  const timeoutMs = input.timeoutMs ?? env.timeoutMs;
  const endpoint = url.endsWith("/evaluate") ? url : `${url.replace(/\/$/, "")}/evaluate`;
  const body = JSON.stringify({
    tool: input.tool,
    args: input.args,
    pack: input.pack ?? env.pack,
  });
  try {
    const res = await withTimeout(
      fetchFn(endpoint, {
        method: "POST",
        headers: authHeaders(input.token ?? env.token),
        body,
      }),
      timeoutMs,
    );
    if (!res.ok) {
      return { ok: false, status: "unreachable", detail: `lexshield http ${res.status}` };
    }
    const parsed = (await res.json()) as unknown;
    const decision = parseDecision(parsed);
    if (!decision) return { ok: false, status: "unreachable", detail: "lexshield response missing decision" };
    return { ok: true, decision };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
    if (code === "TIMEOUT" || (err instanceof Error && err.message === "lexshield_timeout")) {
      return { ok: false, status: "timeout", detail: "lexshield_timeout" };
    }
    return { ok: false, status: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
}

function evaluateCli(input: LexShieldEvaluateInput, env: LexShieldEnv): Promise<LexShieldResult> {
  const pack = input.pack ?? env.pack ?? "";
  const timeoutMs = input.timeoutMs ?? env.timeoutMs;
  const args = [
    "evaluate",
    "--tool",
    input.tool,
    "--args",
    JSON.stringify(input.args ?? {}),
    ...(pack ? ["-c", pack] : []),
  ];
  return new Promise((resolve) => {
    const child = spawn("lexshield", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let done = false;
    const finish = (result: LexShieldResult) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, status: "timeout", detail: "lexshield_timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, status: "unreachable", detail: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (done) return;
      if (code !== 0) {
        finish({ ok: false, status: "unreachable", detail: `lexshield cli exit ${code}` });
        return;
      }
      try {
        const decision = parseDecision(JSON.parse(out) as unknown);
        if (!decision) {
          finish({ ok: false, status: "unreachable", detail: "lexshield cli missing decision" });
          return;
        }
        finish({ ok: true, decision });
      } catch (err) {
        finish({
          ok: false,
          status: "unreachable",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });
}

/** Remote policy check. CLI: `lexshield evaluate --tool --args -c <pack>` (JSON out). */
export async function evaluateLexShield(input: LexShieldEvaluateInput): Promise<LexShieldResult> {
  const env = lexshieldEnv();
  const url = input.url ?? env.url;
  if (input.cli || (!url && process.env.LEXSHIELD_CLI === "1")) {
    return evaluateCli(input, env);
  }
  if (!url) return { ok: false, status: "unconfigured", detail: "LEXSHIELD_URL unset" };
  return evaluateHttp(input, env);
}

export function lexshieldBlocks(result: LexShieldResult): boolean {
  return result.ok && (result.decision === "BLOCK" || result.decision === "CHALLENGE");
}

export function lexshieldUnreachable(result: LexShieldResult): boolean {
  return !result.ok && (result.status === "unreachable" || result.status === "timeout");
}

/**
 * D6/D11.2: fail-closed only when blockT4 is explicitly enabled.
 * Unreachable + blockT4 => VR1010. Unreachable + !blockT4 => record and continue.
 */
export function applyLexShieldPolicy(
  blockT4: boolean,
  tier: string,
  result: LexShieldResult,
): { block: boolean; record: string | undefined } {
  if (result.ok) {
    if (blockT4 && (result.decision === "BLOCK" || result.decision === "CHALLENGE")) {
      return { block: true, record: `lexshield_${result.decision.toLowerCase()}` };
    }
    if (blockT4 && tier === "T4" && result.decision === "ALLOW") {
      return { block: false, record: "lexshield_allow" };
    }
    return { block: false, record: result.ok ? `lexshield_${result.decision.toLowerCase()}` : undefined };
  }
  if (result.status === "unconfigured") {
    return { block: blockT4 && tier === "T4", record: undefined };
  }
  const record = result.status === "timeout" ? "lexshield_timeout" : "lexshield_unreachable";
  if (blockT4) return { block: true, record };
  return { block: false, record };
}

export function throwIfT4Blocked(block: boolean): void {
  if (block) throw new VekRevertError("VR1010", "t4_blocked");
}

void (0 as unknown as JsonValue);
