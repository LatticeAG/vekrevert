/** wrapMcpServer: tool-level capture, fidelity tool_only (D5). */

import type { ActionRef, JsonValue } from "@latticeag/vekrevert-core";
import { closeEffect, openEffect, type EffectHost } from "../effect.ts";

export interface McpServerLike {
  setRequestHandler?: (schema: unknown, handler: (...args: never[]) => unknown) => unknown;
  callTool?: (name: string, args: unknown) => unknown;
}

function mcpAction(tool: string): ActionRef {
  return {
    kind: "mcp_tool",
    name: `mcp.${tool}`,
    target: tool,
    locality: "unknown",
  };
}

async function runMcp<T>(host: EffectHost, tool: string, args: JsonValue, run: () => T | Promise<T>): Promise<T> {
  const sagaId = host.currentSagaId;
  if (!sagaId || !host.ledgerHandle) return await run();
  const opened = await openEffect(host, sagaId, {
    action: mcpAction(tool),
    args: { tool, ...(args && typeof args === "object" ? (args as object) : { value: args }) } as JsonValue,
    run: async () => null,
    capture: { fidelity: "tool_only", interceptor: "wrapMcpServer" },
  });
  try {
    const value = await run();
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

function toolName(schema: unknown, args: unknown[]): string {
  if (typeof schema === "string") return schema;
  if (schema && typeof schema === "object") {
    const rec = schema as Record<string, unknown>;
    if (typeof rec.method === "string") return rec.method;
    if (typeof rec.name === "string") return rec.name;
  }
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "name" in (first as object)) {
    return String((first as { name: unknown }).name);
  }
  return "unknown";
}

export function wrapMcpServer<T extends McpServerLike>(host: EffectHost, server: T): T {
  if (server && typeof server.setRequestHandler === "function") {
    const orig = server.setRequestHandler.bind(server);
    server.setRequestHandler = ((schema: unknown, handler: (...args: never[]) => unknown) => {
      return orig(schema, ((...args: never[]) => {
        const tool = toolName(schema, args);
        const payload = (args[0] ?? {}) as JsonValue;
        return runMcp(host, tool, payload, () => handler(...args));
      }) as never);
    }) as typeof server.setRequestHandler;
  }
  if (server && typeof server.callTool === "function") {
    const orig = server.callTool.bind(server);
    server.callTool = ((name: string, args: unknown) => {
      return runMcp(host, name, (args ?? {}) as JsonValue, () => orig(name, args));
    }) as typeof server.callTool;
  }
  return server;
}
