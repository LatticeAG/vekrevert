"""fs instrumentation stub. Importable; patches nothing until a saga is attached."""

from __future__ import annotations

from typing import Any


def instrument_fs(_module: Any = None) -> Any:
    class _Disp:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return None

        def close(self):
            return None

    return _Disp()
