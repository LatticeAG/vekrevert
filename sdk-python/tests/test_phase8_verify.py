from latticeag_vekrevert.client import VekRevert
from latticeag_vekrevert.verify import (
    draft_compensation,
    execute_gate_rejection,
    record_to_rejection,
    redact_to_shape,
    resolve_verification_policy,
    STRUCTURAL_VERIFIER_MODEL,
    verify_plan,
)


def test_plan_allow_drafted_default_refused():
    v = VekRevert(ledger="memory")
    out = v.plan("eff_x", allow_drafted=True)
    assert out["ok"] is False
    assert out["error_code"] == "VR4005"


def test_plan_without_draft_is_vr3001():
    v = VekRevert(ledger="memory")
    out = v.plan("eff_x")
    assert out["error_code"] == "VR3001"


def test_verify_returns_record_fields():
    v = VekRevert(ledger="memory")
    rec = v.verify("cpl_x")
    assert rec["verdict"] in {"PASS", "FAIL", "UNSURE"}
    assert "plan_hash" in rec
    assert "scope_ok" in rec
    assert "overreach" in rec


def test_t4_draft_refused():
    out = draft_compensation({"tier": "T4", "action": {"kind": "shell", "name": "shell.rm"}, "bindings": {}})
    assert out["error_code"] == "VR4005"


def test_shapes_have_no_values():
    assert redact_to_shape({"id": "inv_secret", "n": 1}) == {"id": "string", "n": "number"}


def test_builtin_skip():
    rec = verify_plan({"origin": "builtin", "plan_hash": "sha256:x", "steps": []})
    assert rec["verdict"] == "PASS"
    assert rec["model"] == "builtin-skip"


def test_verification_policy_defaults_audit():
    assert resolve_verification_policy({"ledger": "memory"}, env={})["mode"] == "audit"


def test_audit_vs_enforce_registered_fail():
    plan = {
        "origin": "registered",
        "plan_hash": "sha256:reg",
        "verification": {
            "verdict": "FAIL",
            "scope_ok": False,
            "overreach": True,
            "reasons": ["test fail"],
            "plan_hash": "sha256:reg",
        },
    }
    assert execute_gate_rejection(plan, "audit") is None
    rej = execute_gate_rejection(plan, "enforce")
    assert rej == record_to_rejection(plan["verification"])
    assert rej["ok"] is False


def test_fallback_caps_at_uncertain():
    def boom(_plan, _receipt):
        raise ConnectionError("ECONNREFUSED")

    rec = verify_plan(
        {"origin": "drafted", "plan_hash": "sha256:fb", "steps": [{"kind": "noop", "reason": "x"}]},
        complete=boom,
        cache={},
    )
    assert rec["model"] == STRUCTURAL_VERIFIER_MODEL
    assert rec["verdict"] == "UNSURE"
    assert rec["fallback_reason"] == "model_unreachable"


def test_cache_ttl_and_budget():
    calls = {"n": 0}

    def complete(_plan, _receipt):
        calls["n"] += 1

    cache: dict = {}
    t0 = __import__("datetime").datetime(2020, 1, 1, tzinfo=__import__("datetime").timezone.utc)
    a = verify_plan(
        {"origin": "drafted", "plan_hash": "sha256:c1", "steps": [{"kind": "noop", "reason": "x"}]},
        complete=complete,
        cache=cache,
        now=t0,
        cache_ttl_ms=1000,
    )
    b = verify_plan(
        {"origin": "drafted", "plan_hash": "sha256:c1", "steps": [{"kind": "noop", "reason": "x"}]},
        complete=complete,
        cache=cache,
        now=t0,
        cache_ttl_ms=1000,
    )
    assert a["verified_at"] == b["verified_at"]
    assert calls["n"] == 1

    budget: dict = {}
    first = verify_plan(
        {"origin": "drafted", "plan_hash": "sha256:b1", "saga_id": "sag_b", "steps": [{"kind": "noop", "reason": "a"}]},
        complete=complete,
        cache={},
        budget_per_saga=1,
        budget_state=budget,
        saga_id="sag_b",
    )
    second = verify_plan(
        {"origin": "drafted", "plan_hash": "sha256:b2", "saga_id": "sag_b", "steps": [{"kind": "noop", "reason": "b"}]},
        complete=complete,
        cache={},
        budget_per_saga=1,
        budget_state=budget,
        saga_id="sag_b",
    )
    assert first.get("fallback_reason") is None
    assert second["fallback_reason"] == "budget_exhausted"
    assert second["model"] == STRUCTURAL_VERIFIER_MODEL



def test_plan_allow_drafted_default_refused():
    v = VekRevert(ledger="memory")
    out = v.plan("eff_x", allow_drafted=True)
    assert out["ok"] is False
    assert out["error_code"] == "VR4005"


def test_plan_without_draft_is_vr3001():
    v = VekRevert(ledger="memory")
    out = v.plan("eff_x")
    assert out["error_code"] == "VR3001"


def test_verify_returns_record_fields():
    v = VekRevert(ledger="memory")
    rec = v.verify("cpl_x")
    assert rec["verdict"] in {"PASS", "FAIL", "UNSURE"}
    assert "plan_hash" in rec
    assert "scope_ok" in rec
    assert "overreach" in rec


def test_t4_draft_refused():
    out = draft_compensation({"tier": "T4", "action": {"kind": "shell", "name": "shell.rm"}, "bindings": {}})
    assert out["error_code"] == "VR4005"


def test_shapes_have_no_values():
    assert redact_to_shape({"id": "inv_secret", "n": 1}) == {"id": "string", "n": "number"}


def test_builtin_skip():
    rec = verify_plan({"origin": "builtin", "plan_hash": "sha256:x", "steps": []})
    assert rec["verdict"] == "PASS"
    assert rec["model"] == "builtin-skip"
