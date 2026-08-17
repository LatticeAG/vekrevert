"""Deterministic resource key construction. Port of packages/core/src/resource.ts."""

from __future__ import annotations

from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse


def _as_record(v) -> dict:
    return v if isinstance(v, dict) else {}


def _str(v) -> str | None:
    if isinstance(v, str):
        return v
    if v is None:
        return None
    return str(v)


def normalize_http_url(url: str) -> dict:
    u = urlparse(url)
    path_parts = [p for p in u.path.split("/") if p not in ("", ".")]
    resolved: list[str] = []
    for p in path_parts:
        if p == "..":
            if resolved:
                resolved.pop()
        else:
            resolved.append(p)
    path = "/" + "/".join(resolved)
    params = sorted(parse_qsl(u.query, keep_blank_values=True))
    query = urlencode(params)
    host = (u.hostname or "").lower()
    netloc = host
    if u.port and not ((u.scheme == "https" and u.port == 443) or (u.scheme == "http" and u.port == 80)):
        netloc = f"{host}:{u.port}"
    href = urlunparse((u.scheme, netloc, path, "", query, ""))
    return {"host": host, "path": path, "href": href}


def resource_keys(input: dict) -> list[str]:
    keys: list[str] = []
    action = input.get("action") or {}
    b = input.get("bindings") or {}
    args = _as_record(input.get("args"))
    headers = input.get("headers") or {}
    kind = action.get("kind")
    if kind == "http":
        loc = _str(b.get("resource_url")) or headers.get("Location") or headers.get("location")
        url = loc or _str(args.get("url"))
        if url:
            try:
                n = normalize_http_url(url)
                keys.append(f"http:{n['host']}:{n['path']}")
            except Exception:
                keys.append(f"http:{action.get('target') or 'unknown'}:{url}")
    if kind == "sql":
        dialect = input.get("dialect") or _str(args.get("dialect")) or "unknown"
        db = input.get("db") or action.get("target") or "app"
        table = input.get("table") or _str(args.get("table")) or "unknown"
        pk = dict(input.get("pk") or {})
        if not pk:
            if b.get("pk") is not None:
                pk["id"] = str(b["pk"])
            if b.get("id") is not None:
                pk["id"] = str(b["id"])
        pk_part = ",".join(f"{k}={v}" for k, v in sorted(pk.items()))
        keys.append(f"sql:{dialect}:{db}:{table}:{pk_part}" if pk_part else f"sql:{dialect}:{db}:{table}")
    if kind == "fs":
        path = input.get("realpath") or _str(args.get("realpath")) or _str(args.get("path")) or action.get("target") or ""
        if path:
            keys.append(f"fs:{path}")
    if kind == "mcp_tool":
        server = input.get("mcpServer") or action.get("target") or "unknown"
        tool = input.get("mcpTool") or (action.get("name") or "tool").split(".")[-1]
        primary = input.get("primaryBinding") or _str(b.get("ts")) or _str(b.get("id")) or "unknown"
        keys.append(f"mcp:{server}:{tool}:{primary}")
    return keys


def action_name(action: dict, extras: dict | None = None) -> str:
    extras = extras or {}
    if action.get("name") and not str(action["name"]).endswith("."):
        return action["name"]
    kind = action.get("kind")
    if kind == "http":
        return f"http.{extras.get('method', 'GET')}.{extras.get('host') or action.get('target') or 'unknown'}{extras.get('path', '')}"
    if kind == "sql":
        return f"sql.{extras.get('sqlKind', 'UNKNOWN')}.{extras.get('db', 'app')}.{extras.get('table', 't')}"
    if kind == "fs":
        return f"fs.{extras.get('op', 'write')}.{extras.get('realpath') or action.get('target') or ''}"
    if kind == "mcp_tool":
        return f"mcp.{extras.get('server', 'server')}.{extras.get('tool', 'tool')}"
    if kind == "sdk_fn":
        return f"sdk.{extras.get('module', 'mod')}.{extras.get('fn', 'fn')}"
    return f"shell.{extras.get('argv0', 'sh')}"
