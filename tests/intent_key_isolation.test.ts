import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("intent_key_isolation", () => {
  it("core/src/intent.ts is not imported by plan/execute/lease/idempotency", () => {
    const forbidden = [
      "packages/core/src/plan.ts",
      "sdk-ts/src/engine/execute.ts",
      "sdk-ts/src/engine/lease.ts",
      "sdk-ts/src/engine/idempotency.ts",
    ];
    const intentRel = "intent.ts";
    for (const f of forbidden) {
      let src = "";
      try {
        src = readFileSync(join(root, f), "utf8");
      } catch {
        continue;
      }
      expect(src.includes(intentRel) || src.includes("stripVolatile") || src.includes("/intent"), f).toBe(false);
    }
    const intentSrc = readFileSync(join(root, "packages/core/src/intent.ts"), "utf8");
    expect(intentSrc).not.toMatch(/plan\.ts|execute\.ts|lease\.ts|idempotency\.ts/);
  });
});
