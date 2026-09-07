/** Drafted-compensation allowlist. Outside the list is still VR4005. */

import type { ActionRef, VekRevertConfig } from "@latticeag/vekrevert-core";
import { workspaceAllowsDrafted } from "./pipeline.ts";

export function globMatchAction(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return value === prefix || value.startsWith(`${prefix}.`);
  }
  if (!pattern.includes("*")) return value === pattern || value.startsWith(`${pattern}.`);
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function messageLike(action: Pick<ActionRef, "kind" | "name">): boolean {
  if (action.kind === "mcp_tool") return true;
  return /message|chat|slack|discord|telegram|mail/i.test(action.name);
}

export function actionMatchesDraftedAllow(
  action: Pick<ActionRef, "kind" | "name">,
  patterns: string[],
): boolean {
  return patterns.some((p) => {
    if (globMatchAction(p, action.name) || globMatchAction(p, action.kind) || globMatchAction(p, `${action.kind}.*`)) {
      return true;
    }
    if ((p === "message.*" || p === "message") && messageLike(action)) return true;
    return false;
  });
}

/** Coarse `allowDrafted` plus optional per-action allowlist. */
export function draftedActionAllowed(
  action: Pick<ActionRef, "kind" | "name">,
  config?: Pick<VekRevertConfig, "allowDrafted" | "drafted">,
): boolean {
  if (!workspaceAllowsDrafted(config)) return false;
  const allow = config?.drafted?.allow;
  if (!allow || allow.length === 0) return true;
  return actionMatchesDraftedAllow(action, allow);
}

export function draftedRequiresGate(config?: Pick<VekRevertConfig, "drafted">): boolean {
  return config?.drafted?.requireGate !== false;
}
