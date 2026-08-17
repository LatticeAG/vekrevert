import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  compilePlan,
  isPlanRejection,
  VekRevertError,
  type ActionRef,
  type CompensationPlan,
  type EffectReceipt,
} from "@latticeag/vekrevert-core";
import { lowerSteps } from "@latticeag/vekrevert-compensators";
import { executeStep, newAttemptId, projectionToReceipt, VekRevert } from "../sdk-ts/src/index.ts";

function sqlAction(kind: "INSERT" | "UPDATE" | "DELETE", table: string): ActionRef {
  return { kind: "sql", name: `sql.${kind}.app.${table}`, target: "app", locality: "internal" };
}

function compileBuiltin(receipt: EffectReceipt): CompensationPlan {
  const vr = new VekRevert({ ledger: "memory" });
  const matched = vr.registry.match(receipt.action, receipt.args_observed, receipt.result_observed);
  expect(matched.matched, "sql builtin should match").toBeTruthy();
  const lowered = lowerSteps(matched.matched!, receipt);
  const plan = compilePlan(receipt, matched.matched!, {
    origin: "builtin",
    ...(lowered ? { steps: lowered.steps } : {}),
  });
  if (isPlanRejection(plan)) throw new Error(`${plan.error_code} ${plan.detail}`);
  return plan;
}

async function lastReceipt(v: VekRevert, sagaId: string): Promise<EffectReceipt> {
  const effects = await v.ledgerHandle!.listEffects(sagaId);
  return projectionToReceipt(effects[effects.length - 1]!);
}

describe("roundtrip_sql", () => {
  it("INSERT / UPDATE / DELETE invert on node:sqlite", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "sql-roundtrip" });

    await saga.effect({
      action: sqlAction("INSERT", "items"),
      args: {
        statement: "INSERT",
        table: "items",
        dialect: "sqlite",
        sql: "INSERT INTO items (name) VALUES ('alpha') RETURNING id",
      },
      run: async () => {
        const row = db.prepare("INSERT INTO items (name) VALUES ('alpha') RETURNING id").get() as { id: number };
        return { id: row.id, status: "ok", changes: 1 };
      },
    });
    const insertReceipt = await lastReceipt(v, saga.id);
    expect(insertReceipt.tier).not.toBe("T4");
    const insertPlan = compileBuiltin(insertReceipt);
    expect(insertPlan.steps[0]).toMatchObject({ kind: "sql_statement", statement: "DELETE" });
    await executeStep(insertPlan.steps[0]!, {
      receipt: insertReceipt,
      signature: v.registry.match(insertReceipt.action, insertReceipt.args_observed, insertReceipt.result_observed).matched!,
      attempt_id: newAttemptId(),
      db,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).toEqual({ n: 0 });

    db.prepare("INSERT INTO items (id, name) VALUES (7, 'before')").run();
    const pre = db.prepare("SELECT id, name FROM items WHERE id = 7").get() as { id: number; name: string };
    await saga.effect({
      action: sqlAction("UPDATE", "items"),
      args: {
        statement: "UPDATE",
        table: "items",
        dialect: "sqlite",
        sql: "UPDATE items SET name = 'after' WHERE id = 7",
      },
      capturePreimage: () => ({ kind: "sql_rows" as const, rows: [pre] }),
      run: async () => {
        db.prepare("UPDATE items SET name = 'after' WHERE id = 7").run();
        const post = db.prepare("SELECT id, name FROM items WHERE id = 7").get() as { id: number; name: string };
        return { id: 7, changes: 1, pre, post };
      },
    });
    const updateReceipt = await lastReceipt(v, saga.id);
    const updatePlan = compileBuiltin(updateReceipt);
    expect(updatePlan.steps[0]).toMatchObject({ kind: "sql_statement", statement: "UPDATE" });
    await executeStep(updatePlan.steps[0]!, {
      receipt: updateReceipt,
      attempt_id: newAttemptId(),
      db,
    });
    expect(db.prepare("SELECT name FROM items WHERE id = 7").get() as { name: string }).toEqual({ name: "before" });

    const delPre = db.prepare("SELECT id, name FROM items WHERE id = 7").get() as { id: number; name: string };
    await saga.effect({
      action: sqlAction("DELETE", "items"),
      args: {
        statement: "DELETE",
        table: "items",
        dialect: "sqlite",
        sql: "DELETE FROM items WHERE id = 7",
      },
      capturePreimage: () => ({ kind: "sql_rows" as const, rows: [delPre] }),
      run: async () => {
        db.prepare("DELETE FROM items WHERE id = 7").run();
        return { id: 7, changes: 1, pre: delPre };
      },
    });
    const deleteReceipt = await lastReceipt(v, saga.id);
    const deletePlan = compileBuiltin(deleteReceipt);
    expect(deletePlan.steps[0]).toMatchObject({ kind: "sql_statement", statement: "INSERT" });
    await executeStep(deletePlan.steps[0]!, {
      receipt: deleteReceipt,
      attempt_id: newAttemptId(),
      db,
    });
    expect(db.prepare("SELECT name FROM items WHERE id = 7").get() as { name: string }).toEqual({ name: "before" });
    db.close();
  });

  it("PK-missing INSERT is T4", async () => {
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "sql-nopk" });
    await saga.effect({
      action: sqlAction("INSERT", "items"),
      args: {
        statement: "INSERT",
        table: "items",
        dialect: "sqlite",
        sql: "INSERT INTO items (name) VALUES ('no-pk')",
      },
      run: async () => ({ changes: 1 }),
    });
    const receipt = projectionToReceipt((await v.ledgerHandle!.listEffects(saga.id))[0]!);
    expect(receipt.tier).toBe("T4");
    expect(receipt.compensation_state).toBe("unavailable");
  });

  it("optimistic concurrency miss is VR5006", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    db.prepare("INSERT INTO items (id, name) VALUES (1, 'a')").run();
    const v = new VekRevert({
      ledger: "memory",
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "sql-occ" });
    const pre = { id: 1, name: "a" };
    await saga.effect({
      action: sqlAction("UPDATE", "items"),
      args: {
        statement: "UPDATE",
        table: "items",
        dialect: "sqlite",
        sql: "UPDATE items SET name = 'b' WHERE id = 1",
      },
      capturePreimage: () => ({ kind: "sql_rows" as const, rows: [pre] }),
      run: async () => {
        db.prepare("UPDATE items SET name = 'b' WHERE id = 1").run();
        return { id: 1, changes: 1, pre, post: { id: 1, name: "b" } };
      },
    });
    db.prepare("UPDATE items SET name = 'third-party' WHERE id = 1").run();
    const receipt = projectionToReceipt((await v.ledgerHandle!.listEffects(saga.id))[0]!);
    const plan = compileBuiltin(receipt);
    await expect(
      executeStep(plan.steps[0]!, { receipt, attempt_id: newAttemptId(), db }),
    ).rejects.toSatisfy((err: unknown) => err instanceof VekRevertError && err.code === "VR5006");
    expect(db.prepare("SELECT name FROM items WHERE id = 1").get() as { name: string }).toEqual({ name: "third-party" });
    db.close();
  });
});
