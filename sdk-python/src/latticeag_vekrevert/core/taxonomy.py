"""Rule-based hot-path classification. Port of packages/core/src/taxonomy.ts (D8)."""

from __future__ import annotations

from urllib.parse import urlparse

from .sqlkind import classify_sql

TIER_ORDER = {"T1": 1, "T2": 2, "T3": 3, "T4": 4}
READ_HTTP = {"GET", "HEAD", "OPTIONS", "TRACE"}
SEARCH_SEGMENTS = {"search", "query", "graphql", "batch", "rpc"}
READ_FS = {"open", "stat", "readdir", "readlink"}
MESSAGE_TOOLS = {
    "chat.postMessage": "T3",
    "slack.chat.postMessage": "T3",
    "discord.createMessage": "T3",
    "telegram.sendMessage": "T3",
}


def max_tier(a: str, b: str) -> str:
    return a if TIER_ORDER[a] >= TIER_ORDER[b] else b


def join_tier(s: dict) -> dict:
    tier = max_tier(s["structural"], s["locality"])
    if s.get("manifest") and not s.get("scopeViolation"):
        tier = s["manifest"]["tier"]
    if s.get("scopeViolation"):
        tier = "T4"
    if s.get("model"):
        tier = max_tier(tier, s["model"]["tier"])
    reason = list(s.get("reasons") or [])
    if not s.get("compensatorMatched") and tier == "T3":
        return {"tier": tier, "reason": reason + ["compensator_unavailable"]}
    return {"tier": tier, "reason": reason}


def _as_record(v) -> dict:
    return v if isinstance(v, dict) else {}


def _str(v) -> str | None:
    return v if isinstance(v, str) else None


def _header(headers: dict | None, name: str) -> str | None:
    if not headers:
        return None
    want = name.lower()
    for k, v in headers.items():
        if str(k).lower() == want:
            return str(v)
    return None


def _last_segment(url: str) -> str:
    try:
        parts = [p for p in urlparse(url).path.split("/") if p]
        return (parts[-1] if parts else "").lower()
    except Exception:
        parts = [p for p in url.split("?")[0].split("/") if p]
        return (parts[-1] if parts else "").lower()


def _has_body(args: dict) -> bool:
    body = args.get("body")
    if body is None:
        return False
    if isinstance(body, str):
        return len(body) > 0
    if isinstance(body, list):
        return len(body) > 0
    if isinstance(body, dict):
        return len(body) > 0
    return True


def _body_id(result) -> bool:
    r = _as_record(result)
    return isinstance(r.get("id"), (str, int))


def _is_private_host(host: str, extra: list[str] | None = None) -> bool:
    extra = extra or []
    h = host.lower().rstrip(".")
    if any(x.lower() == h for x in extra):
        return True
    if h == "localhost" or h.endswith(".localhost"):
        return True
    if h.endswith(".local") or h.endswith(".internal"):
        return True
    if h == "127.0.0.1" or h.startswith("127."):
        return True
    if h == "::1":
        return True
    m = __import__("re").match(r"^(\d+)\.(\d+)\.(\d+)\.(\d+)$", h)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        if a == 10:
            return True
        if a == 172 and 16 <= b <= 31:
            return True
        if a == 192 and b == 168:
            return True
    if h.startswith("fd") or h.startswith("fe80:"):
        return True
    return False


def classify_locality(target: str | None, internal_hosts: list[str] | None = None) -> dict:
    internal_hosts = internal_hosts or []
    if not target:
        return {"locality": "unknown", "tier": "T3", "reasons": ["locality_unknown_treated_external"]}
    host = target
    try:
        if "://" in target:
            host = urlparse(target).hostname or target
    except Exception:
        host = target
    if _is_private_host(host, internal_hosts):
        return {"locality": "internal", "tier": "T1", "reasons": ["locality_internal"]}
    return {"locality": "external", "tier": "T1", "reasons": ["locality_external"]}


AGENT_FS_WRITE = {
    "write_file",
    "writefile",
    "str_replace",
    "patch",
    "edit",
    "mcp__filesystem__write_file",
    "mcp__filesystem__edit_file",
}
AGENT_FS_READ = {
    "read_file",
    "readfile",
    "search_files",
    "list_directory",
    "mcp__filesystem__read_text_file",
    "mcp__filesystem__list_directory",
}
AGENT_HTTP_READ = {"web_search", "websearch", "web_extract", "webextract"}


def rewrite_agent_tool(action: dict, args) -> dict | None:
    kind = action.get("kind")
    if kind not in ("mcp_tool", "sdk_fn"):
        return None
    rec = _as_record(args)
    tool = (_str(rec.get("tool")) or (action.get("name") or "").split(".")[-1] or action.get("name") or "").lower()
    path = _str(rec.get("path")) or _str(rec.get("file_path")) or _str(rec.get("target")) or "/eval-sandbox/file"
    if tool in AGENT_FS_WRITE:
        return {
            "action": {"kind": "fs", "name": f"fs.write.{path}", "target": path, "locality": "internal"},
            "args": {**rec, "op": "write", "path": path, "realpath": path},
        }
    if tool in AGENT_FS_READ:
        op = "readdir" if ("search" in tool or "list" in tool) else "stat"
        return {
            "action": {"kind": "fs", "name": f"fs.{op}.{path}", "target": path, "locality": "internal"},
            "args": {**rec, "op": op, "path": path, "realpath": path},
        }
    if tool in AGENT_HTTP_READ:
        return {
            "action": {
                "kind": "http",
                "name": "http.GET.search.invalid/search",
                "target": "search.invalid",
                "locality": "external",
            },
            "args": {"method": "GET", "url": _str(rec.get("url")) or "https://search.invalid/search"},
        }
    return None


def classify_structural(action: dict, args, ctx: dict | None = None) -> dict:
    ctx = ctx or {}
    aliased = rewrite_agent_tool(action, args)
    if aliased:
        return classify_structural(aliased["action"], aliased["args"], ctx)
    rec = _as_record(args)
    loc = classify_locality(action.get("target") or _str(rec.get("url")) or _str(rec.get("path")), ctx.get("internalHosts"))
    kind = action.get("kind")
    if kind == "shell":
        return {"tier": "T4", "reasons": ["shell_unclassifiable"], "in_doubt": False, "locality": loc["locality"]}
    if kind == "http":
        method = (_str(rec.get("method")) or "")
        if not method:
            parts = (action.get("name") or "").split(".")
            method = parts[1] if len(parts) > 1 else ""
        method = method.upper()
        url = _str(rec.get("url")) or action.get("target") or ""
        headers_obj = _as_record(rec.get("headers"))
        ov = _header(headers_obj, "X-HTTP-Method-Override") or _header(ctx.get("resultHeaders"), "x-http-method-override")
        reasons: list[str] = []
        in_doubt = False
        tier = "T4"
        if ov:
            tier, reasons = "T3", ["method_override"]
        elif method in READ_HTTP and not _has_body(rec):
            tier, reasons = "T1", ["http_safe_method"]
            if _header(ctx.get("resultHeaders"), "set-cookie"):
                tier, reasons = "T2", reasons + ["set_cookie"]
        elif method in READ_HTTP and _has_body(rec):
            tier, reasons = "T3", ["get_with_body"]
        elif method == "POST" and _last_segment(url) in SEARCH_SEGMENTS:
            tier, reasons = "T3", ["post_search_like"]
        elif method == "DELETE":
            if ctx.get("recreateFromPreimage") and ctx.get("preimage") and not ctx["preimage"].get("truncated"):
                tier, reasons = "T3", ["delete_with_preimage"]
            else:
                tier, reasons = "T4", ["delete_without_preimage"]
        elif method in ("PUT", "PATCH"):
            if ctx.get("resultStatus") == 201 and (_header(ctx.get("resultHeaders"), "location") or _body_id(ctx.get("result"))):
                tier, reasons = "T3", ["http_create"]
            elif ctx.get("preimage") and not ctx["preimage"].get("truncated"):
                tier = "T2" if loc["locality"] == "internal" else "T3"
                reasons = ["http_update_with_preimage"]
            else:
                tier, reasons = "T4", ["http_update_without_preimage"]
        elif method in ("POST", "PUT"):
            st = ctx.get("resultStatus")
            if st is not None and st >= 400 and not _header(ctx.get("resultHeaders"), "location") and not _body_id(ctx.get("result")):
                tier, reasons = "T1", ["nothing_landed"]
            elif st == 201 or _header(ctx.get("resultHeaders"), "location") or _body_id(ctx.get("result")):
                tier, reasons = "T3", ["http_create"]
            else:
                tier, reasons = "T3", ["http_mutation"]
        else:
            tier, reasons = "T3", ["http_mutation"]
        if (ctx.get("transportError") or ctx.get("timeout") or (ctx.get("resultStatus") is not None and ctx["resultStatus"] >= 500)) and method not in READ_HTTP:
            in_doubt = True
            reasons.append("http_in_doubt")
            if tier == "T1":
                tier = "T4" if method == "DELETE" else "T3"
        return {"tier": tier, "reasons": reasons, "in_doubt": in_doubt, "locality": loc["locality"]}
    if kind == "sql":
        sql = _str(rec.get("sql")) or _str(rec.get("statement")) or ""
        parsed = classify_sql(sql)
        if parsed["multiStatement"]:
            return {"tier": "T4", "reasons": ["sql_multi_statement"], "in_doubt": False, "locality": loc["locality"]}
        if parsed["kind"] == "SELECT" and not parsed["forUpdate"] and not parsed["modifyingCte"]:
            return {"tier": "T1", "reasons": ["sql_select"], "in_doubt": False, "locality": loc["locality"]}
        internal = (action.get("locality") or loc["locality"]) == "internal"
        t23 = "T2" if internal else "T3"
        if parsed["kind"] == "INSERT":
            if ctx.get("pkResolvable") is False:
                return {"tier": "T4", "reasons": ["insert_no_pk"], "in_doubt": False, "locality": loc["locality"]}
            if ctx.get("pkResolvable") is True or parsed["returning"]:
                return {"tier": t23, "reasons": ["insert_pk"], "in_doubt": False, "locality": loc["locality"]}
            return {"tier": "T4", "reasons": ["insert_no_pk"], "in_doubt": False, "locality": loc["locality"]}
        if parsed["kind"] == "UPDATE":
            if not ctx.get("preimage") or ctx["preimage"].get("truncated"):
                return {"tier": "T4", "reasons": ["update_no_preimage"], "in_doubt": False, "locality": loc["locality"]}
            return {"tier": t23, "reasons": ["update_preimage"], "in_doubt": False, "locality": loc["locality"]}
        if parsed["kind"] == "DELETE":
            if not ctx.get("preimage") or ctx["preimage"].get("truncated"):
                return {"tier": "T4", "reasons": ["delete_no_row_images"], "in_doubt": False, "locality": loc["locality"]}
            return {"tier": t23, "reasons": ["delete_row_images"], "in_doubt": False, "locality": loc["locality"]}
        return {"tier": "T4", "reasons": ["sql_ddl"], "in_doubt": False, "locality": loc["locality"]}
    if kind == "fs":
        op = (_str(rec.get("op")) or (action.get("name") or "fs.write").split(".")[1]).lower()
        path = _str(rec.get("path")) or _str(rec.get("realpath")) or action.get("target") or ""
        roots = ctx.get("writableRoots") or []
        if ctx.get("realpathEscapes") or ctx.get("networkOrFuseMount"):
            return {"tier": "T4", "reasons": ["fs_escape_or_remote"], "in_doubt": False, "locality": "internal"}
        if roots:
            real = _str(rec.get("realpath")) or path
            ok = any(real == r or real.startswith(r if r.endswith("/") else r + "/") for r in roots)
            if not ok:
                return {"tier": "T4", "reasons": ["scope_violation"], "in_doubt": False, "locality": "internal"}
        if op in READ_FS or op == "open_rdonly":
            return {"tier": "T1", "reasons": ["fs_read"], "in_doubt": False, "locality": "internal"}
        if op in ("write", "truncate"):
            pre = ctx.get("preimage")
            fid = ctx.get("captureFidelity")
            if pre and pre.get("truncated"):
                return {"tier": "T4", "reasons": ["preimage_truncated"], "in_doubt": False, "locality": "internal"}
            if pre and pre.get("kind") == "fs_absent":
                return {"tier": "T2", "reasons": ["fs_create"], "in_doubt": False, "locality": "internal"}
            if pre and pre.get("kind") == "fs_bytes":
                return {"tier": "T2", "reasons": ["fs_overwrite"], "in_doubt": False, "locality": "internal"}
            if pre is None and fid and fid != "full":
                return {"tier": "T4", "reasons": ["fidelity_downgrade_no_preimage"], "in_doubt": False, "locality": "internal"}
            return {"tier": "T2", "reasons": ["fs_write_assume_capture" if pre is None else "fs_write"], "in_doubt": False, "locality": "internal"}
        if op in ("mkdir", "rename", "chmod", "chown", "utimes"):
            return {"tier": f"T2", "reasons": [f"fs_{op}"], "in_doubt": False, "locality": "internal"}
        if op == "unlink":
            if ctx.get("preimage") and not ctx["preimage"].get("truncated"):
                return {"tier": "T2", "reasons": ["fs_unlink_preimage"], "in_doubt": False, "locality": "internal"}
            return {"tier": "T4", "reasons": ["fs_unlink_no_preimage"], "in_doubt": False, "locality": "internal"}
        return {"tier": "T4", "reasons": ["fs_unknown"], "in_doubt": False, "locality": "internal"}
    if kind in ("mcp_tool", "sdk_fn"):
        tool = _str(rec.get("tool")) or (action.get("name") or "").split(".")[-1]
        blob = (action.get("name") or "") + (tool or "")
        if __import__("re").search(r"smtp|resend|ses|postmark|email|sendmail", blob, __import__("re").I):
            return {"tier": "T4", "reasons": ["message_irreversible"], "in_doubt": False, "locality": loc["locality"]}
        if __import__("re").search(r"sms|push_notification|notify\.push", blob, __import__("re").I):
            return {"tier": "T4", "reasons": ["message_irreversible"], "in_doubt": False, "locality": loc["locality"]}
        for k, t in MESSAGE_TOOLS.items():
            if tool == k or (action.get("name") or "").endswith(k) or k in (action.get("name") or ""):
                return {"tier": t, "reasons": ["message_retractable"], "in_doubt": False, "locality": loc["locality"]}
        return {"tier": "T4", "reasons": ["mcp_unknown"], "in_doubt": False, "locality": loc["locality"]}
    return {"tier": "T4", "reasons": ["unknown_action_kind"], "in_doubt": False, "locality": loc["locality"]}


def detect_scope_violation(action: dict, args, manifest=None, writable_roots=None) -> bool:
    if action.get("kind") != "fs":
        return False
    path = _str(_as_record(args).get("path")) or action.get("target") or ""
    if writable_roots:
        ok = any(path == r or path.startswith(r if r.endswith("/") else r + "/") for r in writable_roots)
        if not ok:
            return True
    return False


def classify_action(action: dict, args, ctx: dict | None = None) -> dict:
    ctx = ctx or {}
    structural = classify_structural(action, args, ctx)
    loc = classify_locality(action.get("target") or _str(_as_record(args).get("url")), ctx.get("internalHosts"))
    scope = ctx.get("scopeViolation")
    if scope is None:
        scope = detect_scope_violation(action, args, ctx.get("manifest"), ctx.get("writableRoots"))
    loc_tier = "T1" if loc["locality"] != "internal" or structural["tier"] == "T1" else "T2"
    evidence = {
        "structural": structural["tier"],
        "locality": loc_tier,
        "manifest": {"tier": ctx["manifest"]["tier"]} if ctx.get("manifest") else None,
        "model": {"tier": ctx["modelTier"]} if ctx.get("modelTier") else None,
        "scopeViolation": scope,
        "compensatorMatched": ctx.get("compensatorMatched") or False,
        "reasons": structural["reasons"] + loc["reasons"],
    }
    joined = join_tier(evidence)
    sources = [
        {"source": "structural", "tier": structural["tier"], "reasons": structural["reasons"]},
        {"source": "locality", "tier": loc_tier, "reasons": loc["reasons"]},
    ]
    return {
        "tier": joined["tier"],
        "sources": sources,
        "reasons": joined["reason"],
        "candidates": ctx.get("candidates") or [],
        "scope_violation": scope,
    }
