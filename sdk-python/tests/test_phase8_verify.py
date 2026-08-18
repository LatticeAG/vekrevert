from latticeag_vekrevert.client import VekRevert
from latticeag_vekrevert.verify import draft_compensation, redact_to_shape, verify_plan


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
