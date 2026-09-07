"""Hosted HTTP ledger stub. Chain is computed client-side (D7); Python refuses the wire."""

from __future__ import annotations

import os


def resolve_coordinator_url(config: dict | None = None, env: dict | None = None) -> str | None:
    """Unset coordinator URL is a no-op. Hosted wire remains TypeScript-primary."""
    src = env if env is not None else os.environ
    cfg = config or {}
    raw = src.get("VEKREVERT_COORDINATOR_URL") or cfg.get("coordinatorUrl") or cfg.get("coordinator_url") or ""
    if not isinstance(raw, str):
        return None
    stripped = raw.strip()
    return stripped or None


def open_http_ledger(url: str) -> dict:
    # Structured refusal: hosted HTTP ledger wire is TypeScript-primary.
    return {
        "ok": False,
        "error_code": "VR2002",
        "detail": "http ledger hosted wire is TypeScript-primary",
    }


def client_chain_required() -> bool:
    # Documents D7: chain is computed client-side before any POST.
    return True
