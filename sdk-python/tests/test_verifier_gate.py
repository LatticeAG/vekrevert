from latticeag_vekrevert.client import VekRevert
from latticeag_vekrevert.verify import (
    drafted_action_allowed,
    execute_gate_rejection,
    glob_match_action,
    record_to_rejection,
    resolve_verification_policy,
    verification_passes_gate,
    verify_plan,
)


def test_default_mode_is_audit():
    assert resolve_verification_policy({"ledger": "memory"})["mode"] == "audit"


def test_env_overrides_mode(monkeypatch):
    monkeypatch.setenv("VEKREVERT_VERIFICATION_MODE", "enforce")
    assert resolve_verification_policy({"verification": {"mode": "audit"}})["mode"] == "enforce"


def test_audit_does_not_block_registered_fail():
    plan = {
        "origin": "registered",
        "plan_hash": "sha256:x",
        "verification": {
            "verdict": "FAIL",
            "scope_ok": False,
            "overreach": True,
            "reasons": ["no"],
            "plan_hash": "sha256:x",
        },
    }
    assert execute_gate_rejection(plan, "audit") is None
    rej = execute_gate_rejection(plan, "enforce")
    assert rej is not None
    assert rej["ok"] is False
    assert rej["error_code"] in {"VR4001", "VR4004"}


def test_fallback_cap_and_budget():
    plan_a = {"origin": "drafted", "plan_hash": "sha256:a", "saga_id": "sag_b", "steps": [{"kind": "noop", "reason": "a"}]}
    plan_b = {"origin": "drafted", "plan_hash": "sha256:b", "saga_id": "sag_b", "steps": [{"kind": "noop", "reason": "b"}]}
    cache: dict = {}
    budget: dict = {}
    calls = {"n": 0}

    def complete(_plan, _receipt):
        calls["n"] += 1
        raise RuntimeError("ECONNREFUSED")

    rec = verify_plan(plan_a, None, complete=complete, cache=cache, budget_per_saga=1, budget_state=budget, saga_id="sag_b")
    assert rec["model"] == "vekrevert-verifier-structural"
    assert rec["verdict"] == "UNSURE"
    assert rec["fallback_reason"] == "model_unreachable"
    assert verification_passes_gate(rec) is False
    assert record_to_rejection(rec)["error_code"] == "VR4002"

    rec2 = verify_plan(plan_b, None, complete=lambda *_: calls.__setitem__("n", calls["n"] + 1), cache=cache, budget_per_saga=1, budget_state=budget, saga_id="sag_b")
    assert rec2["fallback_reason"] == "budget_exhausted"
    assert rec2["verdict"] == "UNSURE"


def test_allowlist_and_vr4005():
    cfg = {"allowDrafted": True, "drafted": {"allow": ["fs.*"], "requireGate": True}}
    assert glob_match_action("fs.*", "fs.write./tmp/a") is True
    assert drafted_action_allowed({"kind": "fs", "name": "fs.write./tmp/a"}, cfg) is True
    assert drafted_action_allowed({"kind": "http", "name": "http.POST.x/y"}, cfg) is False
    v = VekRevert(ledger="memory", allowDrafted=True, drafted={"allow": ["fs.*"]})
    out = v.plan("eff_x", allow_drafted=True)
    # no receipt + allowlist still refuses drafted http-less unknown effects
    assert out["error_code"] in {"VR4005", "VR3001"}


def test_t4_and_default_still_vr4005():
    v = VekRevert(ledger="memory")
    out = v.plan("eff_x", allow_drafted=True)
    assert out["error_code"] == "VR4005"
