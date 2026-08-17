"""RFC 8785 JCS + sha256 helpers. Must match packages/core/src/jcs.ts byte-for-byte."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _json_string(s: str) -> str:
    out = ['"']
    for ch in s:
        c = ord(ch)
        if c == 0x22:
            out.append('\\"')
        elif c == 0x5C:
            out.append("\\\\")
        elif c == 0x08:
            out.append("\\b")
        elif c == 0x0C:
            out.append("\\f")
        elif c == 0x0A:
            out.append("\\n")
        elif c == 0x0D:
            out.append("\\r")
        elif c == 0x09:
            out.append("\\t")
        elif c < 0x20:
            out.append(f"\\u{c:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonicalize(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int) and not isinstance(value, bool):
        return json.dumps(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("JCS rejects non-finite numbers")
        return json.dumps(value)
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        parts = []
        for k in keys:
            v = value[k]
            if v is None and False:
                continue
            parts.append(_json_string(k) + ":" + canonicalize(v))
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"unsupported JCS type: {type(value)}")


def sha256_hex(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def sha256_prefixed(data: str | bytes) -> str:
    return "sha256:" + sha256_hex(data)


def hash_jcs(value: Any) -> str:
    return sha256_prefixed(canonicalize(value))


def crockford32(data: bytes) -> str:
    bits = 0
    acc = 0
    out: list[str] = []
    for byte in data:
        acc = (acc << 8) | byte
        bits += 8
        while bits >= 5:
            out.append(CROCKFORD[(acc >> (bits - 5)) & 31])
            bits -= 5
            acc &= (1 << bits) - 1
    if bits > 0:
        out.append(CROCKFORD[(acc << (5 - bits)) & 31])
    return "".join(out)


def crockford32_of_sha256(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return crockford32(hashlib.sha256(data).digest())
