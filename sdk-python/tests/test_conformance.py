import json
from pathlib import Path

import pytest

from latticeag_vekrevert.core.jcs import canonicalize, hash_jcs
from latticeag_vekrevert.core.chain import (
    genesis_hash,
    derive_effect_id,
    derive_plan_hash,
    derive_idempotency_key,
    chain_event,
    verify_chain,
)

ROOT = Path(__file__).resolve().parents[2]


def _load(rel: str):
    p = ROOT / rel
    if not p.exists():
        pytest.skip(f"missing {rel}")
    return json.loads(p.read_text())


@pytest.mark.conformance
def test_jcs_cases():
    doc = _load("conformance/jcs/cases.json")
    for c in doc["cases"]:
        assert canonicalize(c["input"]) == c["canonical"], c["name"]


@pytest.mark.conformance
def test_hashing_cases():
    doc = _load("conformance/hashing/cases.json")
    for c in doc["cases"]:
        assert hash_jcs(c["input"]) == c["sha256"], c["name"]


@pytest.mark.conformance
def test_ids_cases():
    doc = _load("conformance/ids/cases.json")
    for c in doc["cases"]:
        if c["name"] == "effect_id_invoice":
            assert (
                derive_effect_id(c["saga_id"], c["seq"], c["action_name"], c["args_hash"])
                == c["effect_id"]
            )
            assert hash_jcs(c["args"]) == c["args_hash"]
        if c["name"] == "plan_hash_and_idempotency":
            assert (
                derive_plan_hash(c["effect_id"], c["compensator_id"], c["origin"], c["steps"])
                == c["plan_hash"]
            )
            assert (
                derive_idempotency_key(
                    c["saga_id"],
                    c["effect_seq"],
                    c["compensator_id"],
                    c["plan_hash"],
                    c["step_index"],
                )
                == c["idempotency_key"]
            )
        if c["name"] == "genesis":
            assert genesis_hash(c["saga_id"]) == c["genesis"]


@pytest.mark.conformance
def test_chain_three_event_saga():
    doc = _load("conformance/chain/three_event_saga.json")
    assert genesis_hash(doc["saga_id"]) == doc["genesis"]
    prev = doc["genesis"]
    for ev in doc["events"]:
        rest = {k: v for k, v in ev.items() if k != "hash"}
        chained = chain_event(rest, prev)
        assert chained["hash"] == ev["hash"]
        assert chained["prev_hash"] == ev["prev_hash"]
        prev = chained["hash"]
    assert verify_chain(doc["events"]) == {"ok": True}


@pytest.mark.conformance
def test_taxonomy_join():
    from latticeag_vekrevert.core.taxonomy import join_tier

    doc = _load("conformance/taxonomy/join.json")
    for c in doc["cases"]:
        assert join_tier(c["evidence"])["tier"] == c["tier"], c["name"]


@pytest.mark.conformance
def test_receipts_seal_hash():
    from latticeag_vekrevert.core.chain import seal_hash

    receipt = _load("conformance/receipts/invoice_create.json")
    seal = receipt["seal_hash"]
    unsealed = {k: v for k, v in receipt.items() if k != "seal_hash"}
    assert seal_hash(unsealed) == seal
    assert receipt["v"] == "vekrevert/v1"
    assert receipt["sealed"] is True

