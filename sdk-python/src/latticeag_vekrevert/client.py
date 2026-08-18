"""Phase 0 stubs. Method bodies raise NotImplementedError until later phases."""

from __future__ import annotations

from typing import Any, Callable


class ActionRef(dict):
    """Minimal ActionRef stand-in; Phase 7 ports the full dataclass."""


class _Registry:
    def register(self, _m: Any) -> Any:
        raise NotImplementedError("not_implemented")

    def list(self) -> list[Any]:
        raise NotImplementedError("not_implemented")

    def match(self, _action: Any, _args: Any) -> Any:
        raise NotImplementedError("not_implemented")


registry = _Registry()


class VekRevert:
    def __init__(self, **kwargs: Any) -> None:
        self.config = kwargs
        self.registry = registry

    def saga(self, key: str | None = None, agent_id: str | None = None) -> "Saga":
        return Saga(self, key=key, agent_id=agent_id)

    def resume_saga(self, saga_id: str, restore_boundary: bool = False) -> "Saga":
        s = Saga(self, key=saga_id)
        s.id = saga_id
        return s

    def classify(self, action: Any, args: Any) -> Any:
        from latticeag_vekrevert.core.taxonomy import classify_action

        return classify_action(
            action if isinstance(action, dict) else dict(action),
            args,
            {
                "writableRoots": self.config.get("writable_roots") or self.config.get("writableRoots"),
                "internalHosts": self.config.get("internal_hosts") or self.config.get("internalHosts"),
            },
        )

    def plan(self, effect_id: str, allow_drafted: bool = False) -> Any:
        from latticeag_vekrevert.verify import plan_allow_drafted

        return plan_allow_drafted(None, allow_drafted, self.config)

    def verify(self, plan_id: str) -> Any:
        from latticeag_vekrevert.verify import verify_plan

        return verify_plan(
            {
                "plan_id": plan_id,
                "plan_hash": "",
                "origin": "drafted",
                "steps": [],
            }
        )

    def execute(self, plan_id: str, **opts: Any) -> Any:
        return {"ok": False, "plan_id": plan_id, "error_code": "VR3001"}

    def undo(self, saga_id: str, **opts: Any) -> Any:
        return {"saga_id": saga_id, "world_restored": False, "compensated": 0, "failed": 0, "escalated": 0}

    def status(self, saga_id: str) -> Any:
        return {"saga_id": saga_id, "pending": 0, "open_escalations": 0}

    def receipts(self, saga_id: str, verify_chain: bool = False) -> Any:
        return {"saga_id": saga_id, "events": [], "chain_ok": True if verify_chain else None}

    def escalate(self, effect_id: str, reason: str) -> Any:
        return {"escalation_id": "esc_stub", "effect_id": effect_id, "reason_code": reason, "status": "pending"}

    def instrument_httpx(self, client: Any) -> Any:
        from latticeag_vekrevert.capture.http import instrument_httpx as impl

        return impl(client)

    def instrument_fs(self) -> Any:
        from latticeag_vekrevert.capture.fs import instrument_fs as impl

        return impl()

    def instrument_sqlalchemy(self, engine: Any) -> Any:
        from latticeag_vekrevert.capture.sql import instrument_sqlalchemy as impl

        return impl(engine)

    def instrument_mcp(self, server: Any) -> Any:
        from latticeag_vekrevert.capture.mcp import instrument_mcp as impl

        return impl(server)


class Saga:
    def __init__(self, vr: VekRevert, key: str | None = None, agent_id: str | None = None) -> None:
        self._vr = vr
        self.key = key
        self.agent_id = agent_id
        self.id = "sag_pending"

    def __enter__(self) -> "Saga":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def effect(self, action: Any, args: Any) -> "EffectCtx":
        return EffectCtx(self, action, args)


class EffectCtx:
    def __init__(self, saga: Saga, action: Any, args: Any) -> None:
        self.saga = saga
        self.action = action
        self.args = args

    def __enter__(self) -> "EffectCtx":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def set_result(self, result: Any, status: int | None = None, headers: dict | None = None) -> None:
        self.result = result
        self.status = status
        self.headers = headers


_default: VekRevert | None = None


def _vr() -> VekRevert:
    global _default
    if _default is None:
        _default = VekRevert(ledger="memory")
    return _default


def saga(key: str | None = None, agent_id: str | None = None) -> Saga:
    return _vr().saga(key=key, agent_id=agent_id)


def resume_saga(saga_id: str, restore_boundary: bool = False) -> Saga:
    return _vr().resume_saga(saga_id, restore_boundary=restore_boundary)


def classify(action: Any, args: Any) -> Any:
    return _vr().classify(action, args)


def plan(effect_id: str, allow_drafted: bool = False) -> Any:
    return _vr().plan(effect_id, allow_drafted=allow_drafted)


def verify(plan_id: str) -> Any:
    return _vr().verify(plan_id)


def execute(plan_id: str, **opts: Any) -> Any:
    return _vr().execute(plan_id, **opts)


def undo(saga_id: str, **opts: Any) -> Any:
    return _vr().undo(saga_id, **opts)


def status(saga_id: str) -> Any:
    return _vr().status(saga_id)


def receipts(saga_id: str, verify_chain: bool = False) -> Any:
    return _vr().receipts(saga_id, verify_chain=verify_chain)


def escalate(effect_id: str, reason: str) -> Any:
    return _vr().escalate(effect_id, reason)


def instrument_httpx(client: Any) -> Any:
    return _vr().instrument_httpx(client)


def instrument_fs() -> Any:
    return _vr().instrument_fs()


def instrument_sqlalchemy(engine: Any) -> Any:
    return _vr().instrument_sqlalchemy(engine)


def instrument_mcp(server: Any) -> Any:
    return _vr().instrument_mcp(server)


__all__ = ["VekRevert", "ActionRef", "Saga", "registry"]
