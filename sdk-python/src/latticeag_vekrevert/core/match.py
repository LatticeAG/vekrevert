"""Deterministic compensator matching. Port of packages/core/src/match.ts (enough for parity)."""

from __future__ import annotations


SOURCE_RANK = {"registered": 0, "builtin": 1, "drafted": 2}


def specificity_score(sig: dict) -> int:
    m = sig.get("match") or {}
    not_star = 1 if m.get("kind") != "*" else 0
    literals = 0
    if m.get("url_pattern") and m.get("url_pattern") != "*":
        literals += 1
    if m.get("path_glob") and "**" not in str(m.get("path_glob")):
        literals += 1
    if m.get("tool"):
        literals += 1
    applies = len(sig.get("applies_when") or [])
    version = 1 if m.get("kind") == "mcp_tool" and m.get("version") else 0
    dialect = 1 if m.get("kind") == "sql" and m.get("dialect") else 0
    return 1000 * not_star + 100 * literals + 50 * applies + 25 * version + 10 * dialect


def _kind_eligible(match: dict, kind: str) -> bool:
    mk = match.get("kind")
    return mk == "*" or mk == kind


def match_compensator(registry: list, action: dict, args, result=None) -> dict:
    scored = []
    predicate_errors = []
    for sig in registry:
        if sig.get("disabled"):
            continue
        m = sig.get("match") or {}
        if not _kind_eligible(m, action.get("kind")):
            continue
        scored.append({"sig": sig, "score": specificity_score(sig)})
    scored.sort(
        key=lambda s: (
            -s["score"],
            SOURCE_RANK.get((s["sig"] or {}).get("source") or "builtin", 9),
            s["sig"].get("id") or "",
        )
    )
    candidates = [{"id": s["sig"]["id"], "score": s["score"], "source": s["sig"].get("source")} for s in scored]
    return {
        "matched": scored[0]["sig"] if scored else None,
        "candidates": candidates,
        "predicate_errors": predicate_errors,
    }
