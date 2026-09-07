"""Phase 8 verify / drafted-plan parity. Structured refusals match the TS core."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Callable

from latticeag_vekrevert.core.plan import compile_plan, is_ref

STRUCTURAL_VERIFIER_MODEL = "vekrevert-verifier-structural"
DEFAULT_VERIFICATION_MODE = "audit"

_VERIFY_CACHE: dict[str, dict] = {}
_VERIFY_BUDGET: dict[str, int] = {}


def env_allow_drafted() -> bool:
    return os.environ.get("VEKREVERT_ALLOW_DRAFTED", "") in {"1", "true", "TRUE", "yes"}


def workspace_allows_drafted(config: dict | None) -> bool:
    cfg = config or {}
    return bool(cfg.get("allowDrafted") or cfg.get("allow_drafted") or env_allow_drafted())


def env_verification_mode(env: dict | None = None) -> str | None:
    src = env if env is not None else os.environ
    raw = str(src.get("VEKREVERT_VERIFICATION_MODE") or "").strip().lower()
    if raw in {"off", "audit", "enforce"}:
        return raw
    return None


def resolve_verification_policy(config: dict | None = None, env: dict | None = None) -> dict:
    cfg = config or {}
    verification = cfg.get("verification") or {}
    models = cfg.get("models") or {}
    verifier = models.get("verifier") or {}
    src = env if env is not None else os.environ
    mode = env_verification_mode(src) or verification.get("mode") or DEFAULT_VERIFICATION_MODE
    model = src.get("VEKREVERT_VERIFICATION_MODEL") or verification.get("model") or verifier.get("model")
    budget = src.get("VEKREVERT_VERIFICATION_BUDGET")
    cache_ttl = src.get("VEKREVERT_VERIFICATION_CACHE_TTL")
    budget_n = verification.get("budgetPerSaga") if budget in (None, "") else int(budget)
    ttl_n = verification.get("cacheTtl") if cache_ttl in (None, "") else int(cache_ttl)
    return {
        "mode": mode,
        "model": model or None,
        "budgetPerSaga": budget_n,
        "cacheTtlMs": ttl_n,
    }


def verification_passes_gate(rec: dict) -> bool:
    return rec.get("verdict") == "PASS" and rec.get("scope_ok") and not rec.get("overreach")


def record_to_rejection(rec: dict) -> dict:
    reasons = rec.get("reasons") or []
    detail = "; ".join(reasons) if reasons else "verifier_unsure"
    if rec.get("overreach"):
        return {"ok": False, "error_code": "VR4004", "stage": "compile", "detail": detail or "overreach_detected"}
    if rec.get("verdict") == "FAIL":
        return {"ok": False, "error_code": "VR4001", "stage": "compile", "detail": detail or "verifier_fail"}
    if rec.get("fallback_reason") == "timeout" or rec.get("model") == "timeout" or "verifier_timeout" in reasons:
        return {"ok": False, "error_code": "VR4003", "stage": "compile", "detail": "verifier_timeout"}
    return {"ok": False, "error_code": "VR4002", "stage": "compile", "detail": detail}


def execute_requires_verification_gate(origin: str, mode: str) -> bool:
    if origin == "drafted":
        return True
    if mode == "enforce" and origin == "registered":
        return True
    return False


def execute_gate_rejection(plan: dict, mode: str) -> dict | None:
    origin = plan.get("origin") or ""
    if not execute_requires_verification_gate(origin, mode):
        return None
    rec = plan.get("verification")
    if rec and rec.get("plan_hash") == plan.get("plan_hash") and verification_passes_gate(rec):
        return None
    if not rec and origin in {"builtin", "registered"}:
        return None
    if rec:
        return record_to_rejection(rec)
    return {"ok": False, "error_code": "VR4002", "stage": "compile", "detail": "missing verification record"}


def _cache_get(cache: dict, plan_hash: str, now: datetime | None, cache_ttl_ms: int | None) -> dict | None:
    hit = cache.get(plan_hash)
    if not hit or hit.get("plan_hash") != plan_hash:
        return None
    if cache_ttl_ms is None:
        return hit
    if now is None:
        return hit
    raw = hit.get("verified_at")
    try:
        at = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    age_ms = (now - at).total_seconds() * 1000
    if age_ms > cache_ttl_ms:
        return None
    return hit


def _take_budget(saga_id: str, budget_per_saga: int | None, state: dict[str, int]) -> bool:
    if budget_per_saga is None:
        return True
    used = state.get(saga_id, 0)
    if used >= budget_per_saga:
        return False
    state[saga_id] = used + 1
    return True


def glob_match_action(pattern: str, value: str) -> bool:
    if pattern == value:
        return True
    if pattern.endswith(".*"):
        prefix = pattern[:-2]
        return value == prefix or value.startswith(prefix + ".")
    if "*" not in pattern:
        return value == pattern or value.startswith(pattern + ".")
    escaped = (
        pattern.replace("\\", "\\\\")
        .replace(".", "\\.")
        .replace("+", "\\+")
        .replace("^", "\\^")
        .replace("$", "\\$")
        .replace("(", "\\(")
        .replace(")", "\\)")
        .replace("{", "\\{")
        .replace("}", "\\}")
        .replace("[", "\\[")
        .replace("]", "\\]")
        .replace("|", "\\|")
        .replace("*", ".*")
    )
    import re

    return re.match(f"^{escaped}$", value) is not None


def action_matches_drafted_allow(action: dict, patterns: list[str]) -> bool:
    name = str(action.get("name") or "")
    kind = str(action.get("kind") or "")
    for p in patterns:
        if glob_match_action(p, name) or glob_match_action(p, kind) or glob_match_action(p, f"{kind}.*"):
            return True
        if p in {"message.*", "message"} and (
            kind == "mcp_tool" or any(tok in name.lower() for tok in ("message", "chat", "slack", "discord", "telegram", "mail"))
        ):
            return True
    return False


def drafted_action_allowed(action: dict, config: dict | None) -> bool:
    if not workspace_allows_drafted(config):
        return False
    allow = ((config or {}).get("drafted") or {}).get("allow")
    if not allow:
        return True
    return action_matches_drafted_allow(action, list(allow))


def redact_to_shape(value: Any) -> Any:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return [redact_to_shape(v) for v in value[:8]]
    if isinstance(value, dict):
        return {k: redact_to_shape(v) for k, v in value.items()}
    return type(value).__name__


def shapes_from_receipt(receipt: dict) -> dict:
    return {
        "action_ref": {
            "kind": (receipt.get("action") or {}).get("kind"),
            "name": (receipt.get("action") or {}).get("name"),
            "locality": (receipt.get("action") or {}).get("locality"),
        },
        "arg_shapes": redact_to_shape(receipt.get("args_observed") or receipt.get("args")),
        "result_shapes": redact_to_shape(receipt.get("result_observed") or receipt.get("result")),
        "binding_names": sorted((receipt.get("bindings") or {}).keys()),
        "tier": receipt.get("tier"),
    }


def draft_compensation(receipt: dict) -> dict:
    if receipt.get("tier") == "T4":
        return {
            "ok": False,
            "error_code": "VR4005",
            "stage": "drafted",
            "detail": "drafted compensations are never used for T4",
        }
    view = shapes_from_receipt(receipt)
    names = view["binding_names"]
    kind = (view["action_ref"] or {}).get("kind")
    if kind == "http" and "resource_url" in names:
        steps = [
            {
                "kind": "http_request",
                "method": "DELETE",
                "url": {"$ref": "receipt.bindings.resource_url"},
                "expect": {"status_in": [200, 202, 204, 404], "treat_404_as_compensated": True},
            }
        ]
        return {"ok": True, "steps": steps, "model": "vekrevert-drafter-heuristic", "view": view}
    if kind == "sql" and "id" in names:
        steps = [
            {
                "kind": "sql_statement",
                "dialect": "unknown",
                "statement": "DELETE",
                "table": {"$ref": "receipt.args.table"},
                "where": {"id": {"$ref": "receipt.bindings.id"}},
                "expect_rowcount": {"min": 1, "max": 1},
            }
        ]
        return {"ok": True, "steps": steps, "model": "vekrevert-drafter-heuristic", "view": view}
    if kind == "fs":
        steps = [
            {
                "kind": "fs_restore",
                "path": {"$ref": "receipt.args.path"},
                "source": {"$ref": "receipt.preimage.blob"},
            }
        ]
        return {"ok": True, "steps": steps, "model": "vekrevert-drafter-heuristic", "view": view}
    return {"ok": False, "error_code": "VR3001", "stage": "drafted", "detail": "no heuristic draft"}


def verify_plan(plan: dict, receipt: dict | None = None, **opts: Any) -> dict:
    origin = plan.get("origin")
    now: datetime | None = opts.get("now")
    cache: dict = opts.get("cache") if opts.get("cache") is not None else _VERIFY_CACHE
    cache_ttl_ms = opts.get("cache_ttl_ms")
    plan_hash = plan.get("plan_hash", "")
    hit = _cache_get(cache, plan_hash, now, cache_ttl_ms)
    if hit:
        return hit
    if origin in {"builtin", "registered"}:
        rec = {
            "verdict": "PASS",
            "scope_ok": True,
            "sufficiency": "full",
            "overreach": False,
            "order_ok": True,
            "reasons": [f"{origin} origin skips the verifier"],
            "model": "builtin-skip",
            "prompt_hash": "sha256:skip",
            "plan_hash": plan_hash,
            "latency_ms": 0,
            "verified_at": (now or datetime(1970, 1, 1, tzinfo=timezone.utc)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        }
        cache[plan_hash] = rec
        return rec
    reasons: list[str] = []
    overreach = False
    steps = plan.get("steps") or []
    mutating = [s for s in steps if isinstance(s, dict) and s.get("kind") not in {"noop", "manual"}]
    if len(mutating) > 1:
        overreach = True
        reasons.append("overreach: extra mutating step")
    blob = str(steps)
    if "ignore previous instructions" in blob.lower() or "delete all invoices" in blob.lower():
        overreach = True
        reasons.append("overreach: injected-response marker")
    if "token=" in blob or "credential." in blob:
        overreach = True
        reasons.append("overreach: credential in plan")
    for s in mutating:
        if s.get("kind") == "http_request" and (s.get("expect") or {}).get("treat_404_as_compensated"):
            action = ((receipt or {}).get("action") or {})
            name = action.get("name") or ""
            if "POST" not in name and "PUT" not in name:
                overreach = True
                reasons.append("overreach: treat_404 abuse")
        if s.get("kind") == "sql_statement":
            table = s.get("table")
            if is_ref(table) and "parent" in table.get("$ref", ""):
                overreach = True
                reasons.append("overreach: parent table")
            erc = s.get("expect_rowcount") or {}
            if isinstance(erc.get("max"), int) and erc["max"] > 1:
                overreach = True
                reasons.append("overreach: over-broad rowcount")
    verdict = "FAIL" if overreach else "UNSURE"
    structural_fail = overreach
    complete: Callable[..., Any] | None = opts.get("complete")
    mode = opts.get("mode")
    want_remote = mode != "off" and complete is not None
    saga_id = str(opts.get("saga_id") or plan.get("saga_id") or "_")
    budget_state: dict[str, int] = opts.get("budget_state") if opts.get("budget_state") is not None else _VERIFY_BUDGET
    budget_ok = (not want_remote) or _take_budget(saga_id, opts.get("budget_per_saga"), budget_state)
    verified_at = (now or datetime(1970, 1, 1, tzinfo=timezone.utc)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    if want_remote and not budget_ok:
        rec = {
            "verdict": "FAIL" if structural_fail else "UNSURE",
            "scope_ok": not overreach,
            "sufficiency": "no" if overreach else "partial",
            "overreach": overreach,
            "order_ok": True,
            "reasons": (reasons or ["python verifier is conservative"]) + ["verifier_fallback: budget_exhausted"],
            "model": STRUCTURAL_VERIFIER_MODEL,
            "prompt_hash": "sha256:py-verify",
            "plan_hash": plan_hash,
            "latency_ms": 0,
            "verified_at": verified_at,
            "fallback_reason": "budget_exhausted",
        }
        cache[plan_hash] = rec
        return rec
    if want_remote and complete is not None:
        try:
            complete(plan, receipt)
        except Exception as err:
            timeout = "timeout" in str(err).lower() or "abort" in str(err).lower()
            rec = {
                "verdict": "FAIL" if structural_fail else "UNSURE",
                "scope_ok": not overreach,
                "sufficiency": "no" if overreach else "partial",
                "overreach": overreach,
                "order_ok": True,
                "reasons": (reasons or ["python verifier is conservative"])
                + [f"verifier_fallback: {'timeout' if timeout else 'model_unreachable'}", str(err)],
                "model": STRUCTURAL_VERIFIER_MODEL,
                "prompt_hash": "sha256:py-verify",
                "plan_hash": plan_hash,
                "latency_ms": 0,
                "verified_at": verified_at,
                "fallback_reason": "timeout" if timeout else "model_unreachable",
            }
            cache[plan_hash] = rec
            return rec
    rec = {
        "verdict": verdict,
        "scope_ok": not overreach,
        "sufficiency": "no" if overreach else "partial",
        "overreach": overreach,
        "order_ok": True,
        "reasons": reasons or ["python verifier is conservative"],
        "model": STRUCTURAL_VERIFIER_MODEL,
        "prompt_hash": "sha256:py-verify",
        "plan_hash": plan_hash,
        "latency_ms": 0,
        "verified_at": verified_at,
    }
    cache[plan_hash] = rec
    return rec


def plan_allow_drafted(receipt: dict | None, allow_drafted: bool, config: dict | None) -> dict:
    if allow_drafted and not workspace_allows_drafted(config):
        return {"ok": False, "error_code": "VR4005", "stage": "drafted", "detail": "drafted_not_allowed"}
    if allow_drafted and receipt is not None and not drafted_action_allowed(receipt.get("action") or {}, config):
        return {"ok": False, "error_code": "VR4005", "stage": "drafted", "detail": "drafted_not_allowed"}
    if not allow_drafted:
        return {"ok": False, "error_code": "VR3001", "stage": "compile", "detail": "no compensator match"}
    if receipt is None:
        return {"ok": False, "error_code": "VR3001", "stage": "compile", "detail": "unknown effect"}
    if not drafted_action_allowed(receipt.get("action") or {}, config):
        return {"ok": False, "error_code": "VR4005", "stage": "drafted", "detail": "drafted_not_allowed"}
    if receipt.get("tier") == "T4":
        return {
            "ok": False,
            "error_code": "VR4005",
            "stage": "drafted",
            "detail": "drafted compensations are never used for T4",
        }
    drafted = draft_compensation(receipt)
    if not drafted.get("ok"):
        return drafted
    signature = {
        "id": "cmp_drafted@0",
        "source": "drafted",
        "reversal_completeness": "best_effort",
        "leak": "downstream_effects",
        "cascade_risk": "low",
        "compensator": {"kind": "declarative", "steps": drafted["steps"]},
    }
    compiled = compile_plan(receipt, signature, {"origin": "drafted", "steps": drafted["steps"]})
    if compiled.get("ok") is False:
        return compiled
    rec = verify_plan(compiled, receipt)
    compiled["verification"] = rec
    mode = resolve_verification_policy(config).get("mode") or DEFAULT_VERIFICATION_MODE
    if rec.get("verdict") != "PASS" or rec.get("overreach") or not rec.get("scope_ok"):
        if mode == "enforce":
            return {
                "ok": False,
                "error_code": "VR4004" if rec.get("overreach") else "VR4002",
                "stage": "drafted",
                "detail": "; ".join(rec.get("reasons") or ["verifier"]),
            }
    return compiled
