from latticeag_vekrevert.ledger.http import client_chain_required, open_http_ledger, resolve_coordinator_url
from latticeag_vekrevert.policy.lexshield import evaluate

# Unreachable on purpose. Not a credential and not a live host.
_BOGUS_URL = "http://127.0.0.1:1"


def test_evaluate_unconfigured_does_not_raise(monkeypatch):
    monkeypatch.delenv("LEXSHIELD_URL", raising=False)
    out = evaluate("http.request", {"method": "GET"}, block_t4=True)
    assert out["ok"] is True
    assert out["status"] == "unconfigured"
    assert out["decision"] is None


def test_evaluate_bogus_url_block_t4_is_vr1010():
    out = evaluate("http.request", {"method": "GET"}, block_t4=True, url=_BOGUS_URL, timeout_s=0.2)
    assert out["ok"] is False
    assert out["error_code"] == "VR1010"
    assert out["detail"] == "t4_blocked"


def test_evaluate_bogus_url_records_unreachable_not_allow():
    out = evaluate("http.request", {"method": "GET"}, block_t4=False, url=_BOGUS_URL, timeout_s=0.2)
    assert out["ok"] is True
    assert out["status"] == "unreachable"
    assert out["recorded"] is True
    assert out["decision"] is None
    assert out.get("decision") != "ALLOW"


def test_open_http_ledger_structured_refusal():
    out = open_http_ledger("https://ledger.invalid")
    assert out["ok"] is False
    assert out["error_code"] == "VR2002"
    assert "TypeScript-primary" in out["detail"]


def test_client_chain_required_documents_d7():
    assert client_chain_required() is True


def test_resolve_coordinator_url_unset_is_none():
    assert resolve_coordinator_url({}, env={}) is None


def test_resolve_coordinator_url_env_and_config():
    assert resolve_coordinator_url({"coordinatorUrl": "http://127.0.0.1:7465"}, env={}) == "http://127.0.0.1:7465"
    assert (
        resolve_coordinator_url({}, env={"VEKREVERT_COORDINATOR_URL": "http://127.0.0.1:9"})
        == "http://127.0.0.1:9"
    )
