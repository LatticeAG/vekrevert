import { describe, expect, it } from "vitest";
import { classifyAction, rewriteAgentTool } from "@latticeag/vekrevert-core";

describe("agent file tools (eval-driven taxonomy)", () => {
  it("write_file / patch classify as fs T2, not mcp_unknown T4", () => {
    const write = classifyAction(
      { kind: "sdk_fn", name: "write_file", locality: "internal" },
      { path: "/eval-sandbox/a.txt" },
      { writableRoots: ["/eval-sandbox"] },
    );
    expect(write.tier).toBe("T2");
    expect(write.reasons.some((r) => r.includes("fs_"))).toBe(true);
    const patch = classifyAction(
      { kind: "sdk_fn", name: "patch", locality: "internal" },
      { path: "/eval-sandbox/b.txt", mode: "replace" },
      { writableRoots: ["/eval-sandbox"] },
    );
    expect(patch.tier).toBe("T2");
  });

  it("read_file is T1; terminal stays T4; unknown MCP stays T4", () => {
    expect(
      classifyAction(
        { kind: "sdk_fn", name: "read_file", locality: "internal" },
        { path: "/eval-sandbox/r.txt" },
        { writableRoots: ["/eval-sandbox"] },
      ).tier,
    ).toBe("T1");
    expect(
      classifyAction({ kind: "shell", name: "shell.terminal", locality: "internal" }, { command: "echo x" }).tier,
    ).toBe("T4");
    expect(
      classifyAction({ kind: "mcp_tool", name: "mcp.other.do", locality: "external" }, { tool: "do" }).tier,
    ).toBe("T4");
  });

  it("rewriteAgentTool maps write_file onto fs.write", () => {
    const out = rewriteAgentTool({ kind: "sdk_fn", name: "write_file", locality: "internal" }, { path: "/tmp/x" });
    expect(out?.action.kind).toBe("fs");
    expect(out?.action.name).toContain("fs.write");
  });
});
