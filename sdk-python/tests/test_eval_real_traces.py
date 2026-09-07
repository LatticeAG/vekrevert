import json
from pathlib import Path

from latticeag_vekrevert.core.taxonomy import classify_action, rewrite_agent_tool

FROZEN = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "real_traces" / "frozen.json"


def test_rewrite_write_file_is_fs():
    out = rewrite_agent_tool({"kind": "sdk_fn", "name": "write_file", "locality": "internal"}, {"path": "/eval-sandbox/a.txt"})
    assert out is not None
    assert out["action"]["kind"] == "fs"


def test_frozen_traces_tier_labels():
    doc = json.loads(FROZEN.read_text())
    traces = doc["traces"]
    assert len(traces) >= 50
    mismatches = []
    for tr in traces:
        for step in tr["steps"]:
            rec = classify_action(step["action"], step["args"], {"writableRoots": ["/eval-sandbox"]})
            if rec["tier"] != step["labels"]["expected_tier"]:
                mismatches.append((tr["id"], step["tool"], rec["tier"], step["labels"]["expected_tier"]))
    assert mismatches == []


def test_unknown_mcp_still_t4():
    rec = classify_action({"kind": "mcp_tool", "name": "mcp.other.do", "locality": "external"}, {"tool": "do"})
    assert rec["tier"] == "T4"
