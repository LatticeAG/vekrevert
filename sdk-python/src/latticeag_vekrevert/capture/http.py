"""ALS-aware httpx wrap. Sets X-VekRevert-Compensation when compensating (D11)."""

from __future__ import annotations

from typing import Any

from latticeag_vekrevert.engine.context import get_compensation_context


def instrument_httpx(client: Any) -> Any:
    if client is None or not hasattr(client, "request"):
        return client
    orig = client.request

    def wrapped(method, url, **kwargs):
        ctx = get_compensation_context()
        if ctx:
            headers = dict(kwargs.get("headers") or {})
            if "X-VekRevert-Compensation" not in headers and "x-vekrevert-compensation" not in {k.lower() for k in headers}:
                headers["X-VekRevert-Compensation"] = ctx
            kwargs["headers"] = headers
        return orig(method, url, **kwargs)

    client.request = wrapped
    return client
