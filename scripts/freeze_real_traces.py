#!/usr/bin/env python3
"""Rebuild tests/fixtures/real_traces/frozen.json from ~/.hermes/state.db.

Redacts paths, contents, and commands. Labels are tool-identity ground truth.
No-ops with a short message if the Hermes DB is missing; CI uses the frozen file.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "fixtures" / "real_traces" / "frozen.json"
HERMES = Path.home() / ".hermes" / "state.db"
V = "vekrevert/v1"


def sid_hash(sid: str) -> str:
    return hashlib.sha256(sid.encode()).hexdigest()[:16]


def take_sessions(cur: sqlite3.Cursor, tool: str, n: int) -> list[str]:
    rows = cur.execute(
        """
        SELECT session_id FROM messages
        WHERE role='assistant' AND tool_calls LIKE ?
        GROUP BY session_id
        ORDER BY session_id
        LIMIT ?
        """,
        (f'%"{tool}"%', n),
    ).fetchall()
    return [r[0] for r in rows]


def add(traces: list, tid: str, source: dict, steps: list, cls: str) -> None:
    traces.append(
        {
            "v": V,
            "id": tid,
            "source": source,
            "class": cls,
            "writable_roots": [f"/eval-sandbox/{tid}"],
            "steps": steps,
            "ground_truth": {
                "full_undo_restores_world": any(s["labels"].get("reversal_success") for s in steps),
                "receipt_chain_valid": True,
            },
        }
    )


def main() -> int:
    traces: list = []
    extracted = "synthetic_pad"
    if HERMES.exists():
        extracted = "~/.hermes/state.db"
        db = sqlite3.connect(f"file:{HERMES}?mode=ro", uri=True)
        cur = db.cursor()
        writes = take_sessions(cur, "write_file", 12)
        patches = take_sessions(cur, "patch", 8)
        reads = take_sessions(cur, "read_file", 10)
        terms = take_sessions(cur, "terminal", 10)
        webs = take_sessions(cur, "web_search", 10)
        db.close()
        i = 0
        for sid in writes:
            i += 1
            tid = f"hermes_write_{i:02d}"
            path = f"/eval-sandbox/{tid}/a.txt"
            add(
                traces,
                tid,
                {"system": "hermes", "session_hash": sid_hash(sid), "tool": "write_file"},
                [
                    {
                        "seq": 1,
                        "tool": "write_file",
                        "action": {"kind": "sdk_fn", "name": "write_file", "target": path, "locality": "internal"},
                        "args": {"path": path, "op": "write"},
                        "run_fixture": {"kind": "inline_fs", "pre_text": "old", "post_text": "new"},
                        "labels": {
                            "had_side_effect": True,
                            "expected_tier": "T2",
                            "expected_compensator": "cmp_fs_write@1",
                            "reversal_success": True,
                            "should_escalate": False,
                        },
                    }
                ],
                "agent_fs_write",
            )
        for sid in patches:
            i += 1
            tid = f"hermes_patch_{i:02d}"
            path = f"/eval-sandbox/{tid}/b.txt"
            add(
                traces,
                tid,
                {"system": "hermes", "session_hash": sid_hash(sid), "tool": "patch"},
                [
                    {
                        "seq": 1,
                        "tool": "patch",
                        "action": {"kind": "sdk_fn", "name": "patch", "target": path, "locality": "internal"},
                        "args": {"path": path, "mode": "replace"},
                        "run_fixture": {"kind": "inline_fs", "pre_text": "alpha", "post_text": "beta"},
                        "labels": {
                            "had_side_effect": True,
                            "expected_tier": "T2",
                            "expected_compensator": "cmp_fs_write@1",
                            "reversal_success": True,
                            "should_escalate": False,
                        },
                    }
                ],
                "agent_fs_patch",
            )
        for sid in reads:
            i += 1
            tid = f"hermes_read_{i:02d}"
            path = f"/eval-sandbox/{tid}/r.txt"
            add(
                traces,
                tid,
                {"system": "hermes", "session_hash": sid_hash(sid), "tool": "read_file"},
                [
                    {
                        "seq": 1,
                        "tool": "read_file",
                        "action": {"kind": "sdk_fn", "name": "read_file", "target": path, "locality": "internal"},
                        "args": {"path": path},
                        "labels": {
                            "had_side_effect": False,
                            "expected_tier": "T1",
                            "reversal_success": False,
                            "should_escalate": False,
                        },
                    }
                ],
                "agent_fs_read",
            )
        for sid in terms:
            i += 1
            tid = f"hermes_term_{i:02d}"
            add(
                traces,
                tid,
                {"system": "hermes", "session_hash": sid_hash(sid), "tool": "terminal"},
                [
                    {
                        "seq": 1,
                        "tool": "terminal",
                        "action": {"kind": "shell", "name": "shell.terminal", "locality": "internal"},
                        "args": {"command": "<redacted>"},
                        "labels": {
                            "had_side_effect": True,
                            "expected_tier": "T4",
                            "reversal_success": False,
                            "should_escalate": True,
                        },
                    }
                ],
                "agent_shell",
            )
        for sid in webs:
            i += 1
            tid = f"hermes_web_{i:02d}"
            add(
                traces,
                tid,
                {"system": "hermes", "session_hash": sid_hash(sid), "tool": "web_search"},
                [
                    {
                        "seq": 1,
                        "tool": "web_search",
                        "action": {"kind": "sdk_fn", "name": "web_search", "locality": "external"},
                        "args": {"query": "<redacted>"},
                        "labels": {
                            "had_side_effect": False,
                            "expected_tier": "T1",
                            "reversal_success": False,
                            "should_escalate": False,
                        },
                    }
                ],
                "agent_http_read",
            )
    else:
        print("Hermes state.db missing; writing synthetic pad only", file=sys.stderr)

    while len(traces) < 50:
        n = len(traces) + 1
        tid = f"hermes_pad_{n:02d}"
        path = f"/eval-sandbox/{tid}/p.txt"
        add(
            traces,
            tid,
            {"system": "hermes", "session_hash": "synthetic", "tool": "write_file"},
            [
                {
                    "seq": 1,
                    "tool": "write_file",
                    "action": {"kind": "sdk_fn", "name": "write_file", "target": path, "locality": "internal"},
                    "args": {"path": path, "op": "write"},
                    "run_fixture": {"kind": "inline_fs", "pre_text": "old", "post_text": "new"},
                    "labels": {
                        "had_side_effect": True,
                        "expected_tier": "T2",
                        "expected_compensator": "cmp_fs_write@1",
                        "reversal_success": True,
                        "should_escalate": False,
                    },
                }
            ],
            "agent_fs_write",
        )

    traces = traces[:50]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "v": V,
                "extracted_from": extracted,
                "note": "Paths rewritten to /eval-sandbox; file contents and commands redacted. Labels are human ground truth from tool identity.",
                "traces": traces,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"wrote {len(traces)} traces ({Counter(t['class'] for t in traces)}) -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
