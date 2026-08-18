import { describe, expect, it } from "vitest";
import { classifyModel, escalateOnly, classifierView } from "../sdk-ts/src/index.ts";

describe("phase8 classify model", () => {
  it("returns null by default (D1)", async () => {
    const out = await classifyModel({ kind: "http", name: "http.POST.x", locality: "external" }, { url: "https://x" });
    expect(out).toBeNull();
  });

  it("can be enabled and remains escalate-only", async () => {
    const out = await classifyModel(
      { kind: "shell", name: "shell.rm", locality: "unknown" },
      { argv0: "rm" },
      { enabled: true },
    );
    expect(out).not.toBeNull();
    expect(out!.tier).toBe("T4");
    expect(escalateOnly("T2", out!.tier)).toBe("T4");
    expect(escalateOnly("T4", "T1")).toBe("T4");
  });

  it("complete seam sees shapes not values", async () => {
    let blob = "";
    await classifyModel(
      { kind: "http", name: "http.POST.x", locality: "external" },
      { authorization: "sk_live_SHOULDNOTSEE", url: "https://x" },
      {
        enabled: true,
        complete: (view) => {
          blob = JSON.stringify(view);
          return "T3";
        },
      },
    );
    expect(blob).not.toContain("sk_live_SHOULDNOTSEE");
    expect(classifierView({ kind: "http", name: "http.POST.x", locality: "external" }, { authorization: "sk_live_X" }).arg_shapes).toEqual({
      authorization: "string",
    });
  });
});
