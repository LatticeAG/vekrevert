"""Compensation contextvars flag (D11)."""

from __future__ import annotations

from contextvars import ContextVar
from contextlib import contextmanager

_compensation: ContextVar[str | None] = ContextVar("vekrevert_compensation", default=None)


def get_compensation_context() -> str | None:
    return _compensation.get()


@contextmanager
def run_with_compensation_context(attempt_id: str):
    token = _compensation.set(attempt_id)
    try:
        yield attempt_id
    finally:
        _compensation.reset(token)
