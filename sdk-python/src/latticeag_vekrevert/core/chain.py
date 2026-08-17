"""Per-saga hash chain. Identical math to packages/core/src/chain.ts (D7, D8)."""

from __future__ import annotations

import hashlib
from typing import Any

from .jcs import canonicalize, crockford32, sha256_hex, sha256_prefixed

NS = "vekrevert/v1"


def genesis_hash(saga_id: str) -> str:
    return sha256_prefixed(f"{NS}:{saga_id}")


def derive_effect_id(saga_id: str, seq: int, action_name: str, args_hash: str) -> str:
    material = f"{saga_id}|{seq}|{action_name}|{args_hash}"
    digest = hashlib.sha256(material.encode("utf-8")).digest()
    return "eff_" + crockford32(digest)[:26]


def derive_intent_key(action_name: str, stripped_args: Any) -> str:
    return sha256_prefixed(canonicalize({"action": action_name, "args": stripped_args}))


def derive_plan_hash(effect_id: str, compensator_id: str, origin: str, steps: Any) -> str:
    return sha256_prefixed(
        canonicalize(
            {
                "effect_id": effect_id,
                "compensator_id": compensator_id,
                "origin": origin,
                "steps": steps,
            }
        )
    )


def derive_idempotency_key(
    saga_id: str,
    effect_seq: int,
    compensator_id: str,
    plan_hash: str,
    step_index: int,
) -> str:
    material = (
        "vekrevert.v1\n"
        + saga_id
        + "\n"
        + str(effect_seq)
        + "\n"
        + compensator_id
        + "\n"
        + plan_hash
        + "\n"
        + str(step_index)
    )
    digest = hashlib.sha256(material.encode("utf-8")).digest()
    return "vr1_" + crockford32(digest)[:32]


def seal_hash(receipt_without_seal: Any) -> str:
    return sha256_prefixed(canonicalize(receipt_without_seal))


def event_body_for_hash(ev: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {
        "v": ev["v"],
        "id": ev["id"],
        "type": ev["type"],
        "ts": ev["ts"],
        "saga_id": ev["saga_id"],
        "chain_seq": ev["chain_seq"],
        "actor": ev["actor"],
        "payload": ev["payload"],
        "prev_hash": ev["prev_hash"],
    }
    if ev.get("effect_id") is not None:
        body["effect_id"] = ev["effect_id"]
    return body


def chain_event(ev: dict[str, Any], prev_hash: str) -> dict[str, Any]:
    with_prev = {**ev, "prev_hash": prev_hash}
    hashed = sha256_prefixed(canonicalize(event_body_for_hash(with_prev)))
    return {**with_prev, "hash": hashed}


def verify_chain(events: list[dict[str, Any]], genesis_saga_id: str | None = None) -> dict[str, Any]:
    if not events:
        return {"ok": True}
    saga_id = genesis_saga_id or events[0]["saga_id"]
    expected_prev = genesis_hash(saga_id)
    expected_seq = 1
    for i, ev in enumerate(events):
        if ev["chain_seq"] != expected_seq:
            return {"ok": False, "brokenAt": i, "reason": "seq_gap"}
        if ev["prev_hash"] != expected_prev:
            return {"ok": False, "brokenAt": i, "reason": "prev_mismatch"}
        recomputed = sha256_prefixed(canonicalize(event_body_for_hash(ev)))
        if recomputed != ev.get("hash"):
            return {"ok": False, "brokenAt": i, "reason": "hash_mismatch"}
        expected_prev = ev.get("hash") or recomputed
        expected_seq += 1
    return {"ok": True}
