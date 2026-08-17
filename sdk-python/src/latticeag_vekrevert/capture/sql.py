"""SQL instrumentation stubs."""

from __future__ import annotations

from typing import Any


def instrument_sqlalchemy(engine: Any) -> Any:
    return engine


def instrument_psycopg(conn: Any) -> Any:
    return conn
