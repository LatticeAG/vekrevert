/** Deterministic resource key construction (§4.5). */

import type { ActionRef, JsonValue } from "./types.ts";

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, JsonValue>;
  return {};
}

function str(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" ? v : v == null ? undefined : String(v);
}

export function normalizeHttpUrl(url: string): { host: string; path: string; href: string } {
  const u = new URL(url);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  const parts = u.pathname.split("/").filter((p) => p !== "." && p !== "");
  const resolved: string[] = [];
  for (const p of parts) {
    if (p === "..") resolved.pop();
    else resolved.push(p);
  }
  u.pathname = "/" + resolved.join("/");
  const params = [...u.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  u.search = "";
  for (const [k, v] of params) u.searchParams.append(k, v);
  return { host: u.hostname, path: u.pathname, href: u.toString() };
}

export function resourceKeys(input: {
  action: ActionRef;
  bindings?: Record<string, JsonValue>;
  args?: JsonValue;
  result?: JsonValue;
  headers?: Record<string, string>;
  dialect?: string;
  db?: string;
  table?: string;
  pk?: Record<string, string>;
  realpath?: string;
  mcpServer?: string;
  mcpTool?: string;
  primaryBinding?: string;
}): string[] {
  const keys: string[] = [];
  const b = input.bindings ?? {};
  if (input.action.kind === "http") {
    const loc = str(b.resource_url) ?? (input.headers?.Location || input.headers?.location);
    const url = loc
      ? (() => {
          try {
            return new URL(loc, str(asRecord(input.args).url) ?? "https://placeholder.invalid").toString();
          } catch {
            return loc;
          }
        })()
      : str(asRecord(input.args).url);
    if (url) {
      try {
        const n = normalizeHttpUrl(url);
        keys.push(`http:${n.host}:${n.path}`);
      } catch {
        keys.push(`http:${input.action.target ?? "unknown"}:${url}`);
      }
    }
  }
  if (input.action.kind === "sql") {
    const rec = asRecord(input.args);
    const dialect = input.dialect ?? str(rec.dialect) ?? "unknown";
    const db = input.db ?? input.action.target ?? "app";
    const table = input.table ?? str(rec.table) ?? "unknown";
    const pk: Record<string, string> = { ...(input.pk ?? {}) };
    if (Object.keys(pk).length === 0) {
      if (b.pk != null) pk.id = String(b.pk);
      if (b.id != null) pk.id = String(b.id);
    }
    const pkPart = Object.entries(pk)
      .sort(([a], [c]) => (a < c ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    keys.push(pkPart ? `sql:${dialect}:${db}:${table}:${pkPart}` : `sql:${dialect}:${db}:${table}`);
  }
  if (input.action.kind === "fs") {
    const rec = asRecord(input.args);
    const path = input.realpath ?? str(rec.realpath) ?? str(rec.path) ?? input.action.target ?? "";
    if (path) keys.push(`fs:${path}`);
    const from = str(rec.from);
    const to = str(rec.to);
    if (from && from !== path) keys.push(`fs:${from}`);
    if (to && to !== path && to !== from) keys.push(`fs:${to}`);
  }
  if (input.action.kind === "mcp_tool") {
    const server = input.mcpServer ?? input.action.target ?? "unknown";
    const tool = input.mcpTool ?? input.action.name.split(".").slice(-1)[0] ?? "tool";
    const primary = input.primaryBinding ?? str(b.ts) ?? str(b.id) ?? str(b.message_id) ?? "unknown";
    keys.push(`mcp:${server}:${tool}:${primary}`);
  }
  return keys;
}

export function actionName(action: ActionRef, extras?: { method?: string; host?: string; path?: string; sqlKind?: string; db?: string; table?: string; op?: string; realpath?: string; server?: string; tool?: string; module?: string; fn?: string; argv0?: string }): string {
  if (action.name && !action.name.endsWith(".")) return action.name;
  switch (action.kind) {
    case "http":
      return `http.${extras?.method ?? "GET"}.${extras?.host ?? action.target ?? "unknown"}${extras?.path ?? ""}`;
    case "sql":
      return `sql.${extras?.sqlKind ?? "UNKNOWN"}.${extras?.db ?? "app"}.${extras?.table ?? "t"}`;
    case "fs":
      return `fs.${extras?.op ?? "write"}.${extras?.realpath ?? action.target ?? ""}`;
    case "mcp_tool":
      return `mcp.${extras?.server ?? "server"}.${extras?.tool ?? "tool"}`;
    case "sdk_fn":
      return `sdk.${extras?.module ?? "mod"}.${extras?.fn ?? "fn"}`;
    case "shell":
      return `shell.${extras?.argv0 ?? "sh"}`;
  }
}
