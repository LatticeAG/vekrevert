"""Keyword-and-CTE-aware SQL kind. Port of packages/core/src/sqlkind.ts."""

from __future__ import annotations

import re

MUTATING = {"INSERT", "UPDATE", "DELETE", "MERGE"}
DDL = {"TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT", "REINDEX", "VACUUM"}


def strip_sql_comments(sql: str) -> str:
    out: list[str] = []
    i = 0
    in_s = in_d = in_line = in_block = False
    while i < len(sql):
        c = sql[i]
        n = sql[i + 1] if i + 1 < len(sql) else ""
        if in_line:
            if c == "\n":
                in_line = False
                out.append(c)
            i += 1
            continue
        if in_block:
            if c == "*" and n == "/":
                in_block = False
                i += 2
                continue
            i += 1
            continue
        if not in_s and not in_d and c == "-" and n == "-":
            in_line = True
            i += 2
            continue
        if not in_s and not in_d and c == "/" and n == "*":
            in_block = True
            i += 2
            continue
        if not in_d and c == "'":
            in_s = not in_s
            out.append(c)
            i += 1
            continue
        if not in_s and c == '"':
            in_d = not in_d
            out.append(c)
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _split_statements(sql: str) -> list[str]:
    parts: list[str] = []
    cur = ""
    in_s = in_d = False
    for c in sql:
        if not in_d and c == "'":
            in_s = not in_s
        elif not in_s and c == '"':
            in_d = not in_d
        if c == ";" and not in_s and not in_d:
            if cur.strip():
                parts.append(cur.strip())
            cur = ""
            continue
        cur += c
    if cur.strip():
        parts.append(cur.strip())
    return parts


def _tokenize(sql: str) -> list[str]:
    return [t for t in re.findall(r'[A-Za-z_][\w$]*|"(?:[^"]|"")+"|\d+|.', sql.replace("\n", " ")) if t.strip()]


def _unquote(ident: str) -> str:
    if ident.startswith('"') and ident.endswith('"'):
        return ident[1:-1].replace('""', '"')
    if ident.startswith("`") and ident.endswith("`"):
        return ident[1:-1]
    return ident


def _table_after(tokens: list[str], keywords: list[str]) -> str | None:
    for i, t in enumerate(tokens[:-1]):
        if t.upper() in keywords:
            j = i + 1
            if j < len(tokens) and tokens[j].upper() == "ONLY":
                j += 1
            if j < len(tokens) and tokens[j].upper() == "IF":
                return None
            if j < len(tokens) and re.match(r'[A-Za-z_"]', tokens[j][0]):
                return _unquote(tokens[j].rstrip("."))
    return None


def _primary_kind(tokens: list[str]) -> str:
    i = 0
    if tokens and tokens[0].upper() == "WITH":
        while i < len(tokens) and tokens[i].upper() not in {
            "SELECT",
            "INSERT",
            "UPDATE",
            "DELETE",
            "TRUNCATE",
            "CALL",
            "EXEC",
        }:
            i += 1
    if i >= len(tokens):
        return "UNKNOWN"
    k = tokens[i].upper()
    if k in {
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "DROP",
        "ALTER",
        "CREATE",
        "GRANT",
        "REINDEX",
        "VACUUM",
        "CALL",
    }:
        return k
    if k in ("EXEC", "EXECUTE"):
        return "EXEC"
    if k in DDL:
        return k
    return "UNKNOWN"


def classify_sql(sql: str) -> dict:
    stripped = strip_sql_comments(sql)
    statements = _split_statements(stripped)
    multi = len(statements) > 1
    primary = statements[0] if statements else ""
    tokens = _tokenize(primary)
    upper = [t.upper() for t in tokens]
    modifying_cte = False
    for i, t in enumerate(tokens):
        if t.upper() == "AS" and i + 1 < len(tokens) and tokens[i + 1] == "(":
            for j in range(i + 2, min(len(tokens), i + 12)):
                if tokens[j].upper() in MUTATING:
                    modifying_cte = True
                    break
                if tokens[j] == ")":
                    break
    kind = _primary_kind(tokens)
    if modifying_cte:
        for t in tokens:
            u = t.upper()
            if u in MUTATING and u != "MERGE":
                kind = u
    for_update = (
        kind == "SELECT"
        and ("UPDATE" in upper or "SHARE" in upper)
        and any(upper[i] == "FOR" and i + 1 < len(upper) and upper[i + 1] in ("UPDATE", "SHARE") for i in range(len(upper)))
    )
    returning = "RETURNING" in upper
    table = None
    if kind == "INSERT":
        table = _table_after(tokens, ["INTO"])
    elif kind == "UPDATE":
        table = _table_after(tokens, ["UPDATE"])
    elif kind == "DELETE":
        table = _table_after(tokens, ["FROM"])
    elif kind == "SELECT":
        table = _table_after(tokens, ["FROM"])
    elif kind == "TRUNCATE":
        table = _table_after(tokens, ["TRUNCATE", "TABLE"])
    else:
        table = _table_after(tokens, ["TABLE", "INDEX", "ON"])
    return {
        "kind": kind,
        "table": table,
        "multiStatement": multi,
        "modifyingCte": modifying_cte,
        "forUpdate": for_update,
        "returning": returning,
    }
