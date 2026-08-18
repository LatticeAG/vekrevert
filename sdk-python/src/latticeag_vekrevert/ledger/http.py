"""Hosted HTTP ledger stub. Chain is computed client-side (D7); Python refuses the wire."""

from __future__ import annotations


def open_http_ledger(url: str) -> dict:
    # Structured refusal: hosted HTTP ledger wire is TypeScript-primary.
    return {
        "ok": False,
        "error_code": "VR2002",
        "detail": "http ledger hosted wire is TypeScript-primary",
    }


def client_chain_required() -> bool:
    # Documents D7: chain is computed client-side before any POST.
    return True
