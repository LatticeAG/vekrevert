from latticeag_vekrevert.client import VekRevert
from latticeag_vekrevert.coordinate import parse_conflict_verdict, resolve_coordinator_url


def test_unset_coordinator_url():
    assert resolve_coordinator_url({"ledger": "memory"}) is None
    vr = VekRevert(ledger="memory")
    assert resolve_coordinator_url(vr.config) is None


def test_env_overrides_coordinator_url(monkeypatch):
    monkeypatch.setenv("VEKREVERT_COORDINATOR_URL", "http://127.0.0.1:7733")
    assert resolve_coordinator_url({"coordinatorUrl": "http://ignored"}) == "http://127.0.0.1:7733"


def test_conflict_verdict_unknown_is_in_doubt():
    parsed = parse_conflict_verdict({"resource_key": "k"})
    assert parsed["verdict"] == "in_doubt"
    assert parse_conflict_verdict({"verdict": "loser"})["verdict"] == "loser"
