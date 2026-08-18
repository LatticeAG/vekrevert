"""Phase 8 verify / drafted-plan parity. Structured refusals match the TS core."""

from __future__ import annotations

import os
from typing import Any

from latticeag_vekrevert.core.plan import compile_plan, is_ref


def env_allow_drafted() -> bool:
    return os.environ.get("VEKREVERT_ALLOW_DRAFTED", "") in {"1", "true", "TRUE", "yes"}


def workspace_allows_drafted(config: dict | None) -> bool:
    cfg = config or {}
    return bool(cfg.get("allowDrafted") or cfg.get("allow_drafted") or env_allow_drafted())


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


def verify_plan(plan: dict, receipt: dict | None = None) -> dict:
    origin = plan.get("origin")
    if origin in {"builtin", "registered"}:
        return {
            "verdict": "PASS",
            "scope_ok": True,
            "sufficiency": "full",
            "overreach": False,
            "order_ok": True,
            "reasons": [f"{origin} origin skips the verifier"],
            "model": "builtin-skip",
            "prompt_hash": "sha256:skip",
            "plan_hash": plan.get("plan_hash", ""),
            "latency_ms": 0,
            "verified_at": "1970-01-01T00:00:00.000Z",
        }
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
    if not overreach and len(mutating) == 1:
        verdict = "UNSURE"
    return {
        "verdict": verdict,
        "scope_ok": not overreach,
        "sufficiency": "no" if overreach else "partial",
        "overreach": overreach,
        "order_ok": True,
        "reasons": reasons or ["python verifier is conservative"],
        "model": "vekrevert-verifier-structural",
        "prompt_hash": "sha256:py-verify",
        "plan_hash": plan.get("plan_hash", ""),
        "latency_ms": 0,
        "verified_at": "1970-01-01T00:00:00.000Z",
    }


def plan_allow_drafted(receipt: dict | None, allow_drafted: bool, config: dict | None) -> dict:
    if allow_drafted and not workspace_allows_drafted(config):
        return {"ok": False, "error_code": "VR4005", "stage": "drafted", "detail": "drafted_not_allowed"}
    if not allow_drafted:
        return {"ok": False, "error_code": "VR3001", "stage": "compile", "detail": "no compensator match"}
    if receipt is None:
        return {"ok": False, "error_code": "VR3001", "stage": "compile", "detail": "unknown effect"}
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
    if rec.get("verdict") != "PASS" or rec.get("overreach") or not rec.get("scope_ok"):
        return {
            "ok": False,
            "error_code": "VR4004" if rec.get("overreach") else "VR4002",
            "stage": "drafted",
            "detail": "; ".join(rec.get("reasons") or ["verifier"]),
        }
    return compiled
