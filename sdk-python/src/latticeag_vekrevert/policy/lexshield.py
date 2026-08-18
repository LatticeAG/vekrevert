"""LexShield adapter stub. Local policy is TypeScript-primary; this records reachability."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


def evaluate(
    tool: Any,
    args: Any,
    *,
    block_t4: bool = False,
    url: str | None = None,
    timeout_s: float = 2.0,
) -> dict:
    resolved = url if url is not None else os.environ.get("LEXSHIELD_URL")
    if isinstance(resolved, str):
        resolved = resolved.strip()
    if not resolved:
        # No remote shield configured. Local blockT4 enforcement is TS.
        return {"ok": True, "status": "unconfigured", "decision": None}

    req = urllib.request.Request(
        resolved,
        data=json.dumps({"tool": tool, "args": args}).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = resp.read()
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        if block_t4:
            return {"ok": False, "error_code": "VR1010", "detail": "t4_blocked"}
        return {"ok": True, "status": "unreachable", "recorded": True, "decision": None}

    decision = None
    try:
        parsed = json.loads(body.decode("utf-8"))
        if isinstance(parsed, dict):
            decision = parsed.get("decision")
    except (UnicodeDecodeError, json.JSONDecodeError):
        decision = None
    return {"ok": True, "status": "ok", "decision": decision}
