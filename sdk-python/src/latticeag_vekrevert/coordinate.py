"""Coordinator URL resolution. The TypeScript process is the lease authority."""

from __future__ import annotations

import os
from typing import Any


def resolve_coordinator_url(config: dict | None = None, env: dict | None = None) -> str | None:
    src: Any = env if env is not None else os.environ
    cfg = config or {}
    raw = str(src.get("VEKREVERT_COORDINATOR_URL") or cfg.get("coordinatorUrl") or cfg.get("coordinator_url") or "").strip()
    return raw or None


def parse_conflict_verdict(body: dict) -> dict:
    verdict = body.get("verdict")
    if verdict not in {"winner", "loser", "in_doubt"}:
        verdict = "in_doubt"
    return {**body, "verdict": verdict}
