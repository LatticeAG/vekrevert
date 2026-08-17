"""Plan compiler subset: compile_plan, assert_provenance, assert_scope (D8)."""

from __future__ import annotations

from .chain import derive_plan_hash

VALUE_FIELDS = {"url", "path", "from", "to", "sql", "table", "where", "body", "args", "set", "values"}


def _reject(code: str, stage: str, detail: str) -> dict:
    return {"ok": False, "error_code": code, "stage": stage, "detail": detail}


def is_ref(v) -> bool:
    return isinstance(v, dict) and set(v.keys()) == {"$ref"} and isinstance(v.get("$ref"), str)


def assert_provenance(steps: list) -> dict | None:
    def walk(obj, path: str):
        if is_ref(obj):
            return None
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k in VALUE_FIELDS and not is_ref(v) and isinstance(v, (str, int, float, bool)):
                    return _reject("VR3007", "provenance", f"{path}.{k}")
                err = walk(v, f"{path}.{k}")
                if err:
                    return err
        elif isinstance(obj, list):
            for i, x in enumerate(obj):
                err = walk(x, f"{path}[{i}]")
                if err:
                    return err
        return None

    for i, step in enumerate(steps or []):
        err = walk(step, f"steps[{i}]")
        if err:
            return err
    return None


def assert_scope(steps: list, resolved: list, receipt: dict, signature=None, origin: str = "builtin") -> dict | None:
    keys = set(receipt.get("resource_keys") or [])
    for i, val in enumerate(resolved or []):
        step = steps[i] if i < len(steps) else {}
        kind = step.get("kind") if isinstance(step, dict) else None
        if kind in ("noop", "manual"):
            continue
        target = None
        if isinstance(val, dict):
            target = val.get("url") or val.get("path")
        if isinstance(target, str) and keys:
            ok = any(target in k or k.split(":")[-1] in target for k in keys)
            if not ok:
                return _reject("VR3008", "scope", str(target))
    return None


def compile_plan(receipt: dict, signature: dict, opts: dict | None = None) -> dict:
    opts = opts or {}
    origin = opts.get("origin") or signature.get("source") or "builtin"
    steps = opts.get("steps")
    if steps is None:
        comp = signature.get("compensator") or {}
        steps = comp.get("steps")
    if not steps:
        return _reject("VR3005", "schema", "no steps")
    prov = assert_provenance(steps)
    if prov:
        return prov
    plan_hash = derive_plan_hash(receipt["effect_id"], signature["id"], origin, steps)
    return {
        "v": "vekrevert/v1",
        "plan_id": opts.get("plan_id", "cpl_pending"),
        "effect_id": receipt["effect_id"],
        "saga_id": receipt.get("saga_id"),
        "compensator_id": signature["id"],
        "origin": origin,
        "steps": steps,
        "plan_hash": plan_hash,
        "reversal_completeness": signature.get("reversal_completeness", "full"),
        "leak": signature.get("leak", "none"),
        "cascade_risk": signature.get("cascade_risk", "none"),
        "summary": f"{len(steps)} steps",
        "created_at": "1970-01-01T00:00:00.000Z",
    }
