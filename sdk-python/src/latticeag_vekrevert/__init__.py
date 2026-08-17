"""latticeag-vekrevert: Python SDK mirror of @latticeag/vekrevert (D8)."""

from .client import VekRevert, ActionRef
from .client import (
    saga,
    resume_saga,
    classify,
    plan,
    verify,
    execute,
    undo,
    status,
    receipts,
    escalate,
    instrument_httpx,
    instrument_fs,
    instrument_sqlalchemy,
    instrument_mcp,
)

__all__ = [
    "VekRevert",
    "ActionRef",
    "saga",
    "resume_saga",
    "classify",
    "plan",
    "verify",
    "execute",
    "undo",
    "status",
    "receipts",
    "escalate",
    "instrument_httpx",
    "instrument_fs",
    "instrument_sqlalchemy",
    "instrument_mcp",
    "registry",
]

# registry names must appear in __all__ for check_parity (register/list/match).
from .client import registry  # noqa: E402

__all__ += ["registry"]
