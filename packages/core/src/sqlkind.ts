/** Keyword-and-CTE-aware SQL kind. Not a regex over the whole string. */

import type { SqlKind } from "./types.ts";

const MUTATING = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);
const DDL = new Set(["TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT", "REINDEX", "VACUUM"]);

export interface SqlClassification {
  kind: SqlKind;
  table?: string;
  multiStatement: boolean;
  modifyingCte: boolean;
  forUpdate: boolean;
  returning: boolean;
}

export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  let inS = false;
  let inD = false;
  let inLine = false;
  let inBlock = false;
  while (i < sql.length) {
    const c = sql[i]!;
    const n = sql[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (!inS && !inD && c === "-" && n === "-") {
      inLine = true;
      i += 2;
      continue;
    }
    if (!inS && !inD && c === "/" && n === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (!inD && c === "'") {
      inS = !inS;
      out += c;
      i++;
      continue;
    }
    if (!inS && c === '"') {
      inD = !inD;
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inS = false;
  let inD = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (!inD && c === "'") inS = !inS;
    else if (!inS && c === '"') inD = !inD;
    if (c === ";" && !inS && !inD) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function nextKeyword(tokens: string[], i: number): string | undefined {
  return tokens[i]?.toUpperCase();
}

function tokenize(sql: string): string[] {
  const tokens: string[] = [];
  const re = /[A-Za-z_][\w$]*|"(?:[^"]|"")+"|\d+|./g;
  let m: RegExpExecArray | null;
  const s = sql.replace(/\s+/g, " ").trim();
  while ((m = re.exec(s))) {
    const t = m[0]!;
    if (t.trim() === "") continue;
    tokens.push(t);
  }
  return tokens;
}

function unquote(ident: string): string {
  if (ident.startsWith('"') && ident.endsWith('"')) return ident.slice(1, -1).replace(/""/g, '"');
  if (ident.startsWith("`") && ident.endsWith("`")) return ident.slice(1, -1);
  return ident;
}

function tableAfter(tokens: string[], keywords: string[]): string | undefined {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (keywords.includes(tokens[i]!.toUpperCase())) {
      let j = i + 1;
      if (tokens[j]?.toUpperCase() === "ONLY") j++;
      if (tokens[j]?.toUpperCase() === "IF") return undefined;
      const t = tokens[j];
      if (t && /[A-Za-z_"]/.test(t[0]!)) return unquote(t.replace(/\.$/, ""));
    }
  }
  return undefined;
}

function hasModifyingCte(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.toUpperCase() === "AS" && tokens[i + 1] === "(") {
      for (let j = i + 2; j < Math.min(tokens.length, i + 12); j++) {
        if (MUTATING.has(tokens[j]!.toUpperCase())) return true;
        if (tokens[j] === ")") break;
      }
    }
  }
  return false;
}

function innermostMutating(tokens: string[]): SqlKind | undefined {
  let last: SqlKind | undefined;
  for (const t of tokens) {
    const u = t.toUpperCase();
    if (MUTATING.has(u) && u !== "MERGE") last = u as SqlKind;
  }
  return last;
}

function primaryKind(tokens: string[]): SqlKind {
  let i = 0;
  if (nextKeyword(tokens, i) === "WITH") {
    while (i < tokens.length && !["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "CALL", "EXEC"].includes(tokens[i]!.toUpperCase())) {
      i++;
    }
  }
  const k = nextKeyword(tokens, i);
  if (!k) return "UNKNOWN";
  if (k === "SELECT") return "SELECT";
  if (k === "INSERT") return "INSERT";
  if (k === "UPDATE") return "UPDATE";
  if (k === "DELETE") return "DELETE";
  if (k === "TRUNCATE") return "TRUNCATE";
  if (k === "DROP") return "DROP";
  if (k === "ALTER") return "ALTER";
  if (k === "CREATE") return "CREATE";
  if (k === "GRANT") return "GRANT";
  if (k === "REINDEX") return "REINDEX";
  if (k === "VACUUM") return "VACUUM";
  if (k === "CALL") return "CALL";
  if (k === "EXEC" || k === "EXECUTE") return "EXEC";
  if (DDL.has(k)) return k as SqlKind;
  return "UNKNOWN";
}

export function classifySql(sql: string): SqlClassification {
  const stripped = stripSqlComments(sql);
  const statements = splitStatements(stripped);
  const multiStatement = statements.length > 1;
  const primary = statements[0] ?? "";
  const tokens = tokenize(primary);
  const modifyingCte = hasModifyingCte(tokens);
  let kind = primaryKind(tokens);
  if (modifyingCte) {
    kind = innermostMutating(tokens) ?? kind;
  }
  const upper = tokens.map((t) => t.toUpperCase());
  const forUpdate =
    kind === "SELECT" &&
    (upper.includes("UPDATE") || upper.includes("SHARE")) &&
    upper.some((t, i) => t === "FOR" && (upper[i + 1] === "UPDATE" || upper[i + 1] === "SHARE"));
  const returning = upper.includes("RETURNING");
  let table: string | undefined;
  if (kind === "INSERT") table = tableAfter(tokens, ["INTO"]);
  else if (kind === "UPDATE") table = tableAfter(tokens, ["UPDATE"]);
  else if (kind === "DELETE") table = tableAfter(tokens, ["FROM"]);
  else if (kind === "SELECT") table = tableAfter(tokens, ["FROM"]);
  else if (kind === "TRUNCATE") table = tableAfter(tokens, ["TRUNCATE", "TABLE"]);
  else table = tableAfter(tokens, ["TABLE", "INDEX", "ON"]);
  return { kind, table, multiStatement, modifyingCte, forUpdate, returning };
}
