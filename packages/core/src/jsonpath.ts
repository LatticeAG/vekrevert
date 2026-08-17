/** JSONPath subset: dot/bracket, no filters, no recursive descent (§4.7). */

import type { JsonValue } from "./types.ts";

export function evalJsonPath(root: JsonValue | undefined, path: string): JsonValue | undefined {
  if (root === undefined) return undefined;
  let p = path.trim();
  if (p.startsWith("$.")) p = p.slice(2);
  else if (p === "$") return root;
  else if (p.startsWith("$[")) p = p.slice(1);
  else if (p.startsWith("$")) p = p.slice(1);

  let cur: JsonValue | undefined = root;
  let i = 0;
  while (i < p.length && cur !== undefined) {
    if (p[i] === ".") {
      i++;
      continue;
    }
    if (p[i] === "[") {
      const close = p.indexOf("]", i);
      if (close < 0) throw new Error("unclosed JSONPath bracket");
      const raw = p.slice(i + 1, close).trim();
      i = close + 1;
      if (raw.startsWith("'") || raw.startsWith('"')) {
        const key = raw.slice(1, -1);
        cur = fromKey(cur, key);
      } else {
        if (!/^\d+$/.test(raw)) throw new Error("JSONPath filter expressions are not supported");
        cur = fromKey(cur, raw);
      }
      continue;
    }
    if (p[i] === "?" || (p[i] === "." && p[i + 1] === ".")) {
      throw new Error("JSONPath filters and recursive descent are not supported");
    }
    let j = i;
    while (j < p.length && p[j] !== "." && p[j] !== "[") j++;
    const key = p.slice(i, j);
    if (key.includes("..")) throw new Error("JSONPath recursive descent is not supported");
    cur = fromKey(cur, key);
    i = j;
  }
  return cur;
}

function fromKey(cur: JsonValue, key: string): JsonValue | undefined {
  if (Array.isArray(cur)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 0 || n >= cur.length) return undefined;
    return cur[n];
  }
  if (cur && typeof cur === "object") {
    return (cur as Record<string, JsonValue>)[key];
  }
  return undefined;
}
