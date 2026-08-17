import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function compileBuiltin(receipt: EffectReceipt): CompensationPlan {
  const vr = new VekRevert({ ledger: "memory" });
  const matched = vr.registry.match(receipt.action, receipt.args_observed, receipt.result_observed);
  expect(matched.matched, "fs builtin should match").toBeTruthy();
  const lowered = lowerSteps(matched.matched!, receipt);
  const plan = compilePlan(receipt, matched.matched!, {
    origin: "builtin",
    ...(lowered ? { steps: lowered.steps } : {}),
  });
  if (isPlanRejection(plan)) throw new Error(`${plan.error_code} ${plan.detail}`);
  return plan;
}

function captureFs(path: string) {
  return (): { kind: "fs_absent" | "fs_bytes"; bytes?: Uint8Array; meta: Record<string, string | number> } => {
    if (!existsSync(path)) return { kind: "fs_absent", meta: { realpath: path } };
    const st = lstatSync(path);
    if (st.isDirectory()) {
      return {
        kind: "fs_absent",
        meta: { realpath: realpathSync(path), mode: st.mode, dev: st.dev, ino: Number(st.ino) },
      };
    }
    const bytes = new Uint8Array(readFileSync(path));
    return {
      kind: "fs_bytes",
      bytes,
      meta: {
        realpath: realpathSync(path),
        mode: st.mode,
        uid: st.uid,
        gid: st.gid,
        mtime_ns: Math.round(st.mtimeMs * 1e6),
        dev: st.dev,
        ino: Number(st.ino),
        size: st.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  };
}

function fsAction(op: string, path: string): ActionRef {
  return { kind: "fs", name: `fs.${op}.${path}`, target: path, locality: "internal" };
}

async function lastReceipt(v: VekRevert, sagaId: string): Promise<EffectReceipt> {
  const effects = await v.ledgerHandle!.listEffects(sagaId);
  return projectionToReceipt(effects[effects.length - 1]!);
}

describe("roundtrip_fs", () => {
  it("write / create / unlink / mkdir / rename / chmod restore against a tmp dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "vr-fs-"));
    const v = new VekRevert({
      ledger: "memory",
      writableRoots: [root],
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "fs-roundtrip" });

    const existing = join(root, "existing.txt");
    writeFileSync(existing, "old");
    await saga.effect({
      action: fsAction("write", existing),
      args: { op: "write", path: existing, realpath: existing },
      capturePreimage: captureFs(existing),
      run: async () => {
        writeFileSync(existing, "new");
        return { ok: true };
      },
    });
    const writeReceipt = await lastReceipt(v, saga.id);
    const writePlan = compileBuiltin(writeReceipt);
    expect(writePlan.steps[0]?.kind).toBe("fs_restore");
    await executeStep(writePlan.steps[0]!, {
      receipt: writeReceipt,
      signature: v.registry.match(writeReceipt.action, writeReceipt.args_observed)!.matched!,
      attempt_id: newAttemptId(),
      ledger: v.ledgerHandle,
      writableRoots: [root],
    });
    expect(readFileSync(existing, "utf8")).toBe("old");

    const created = join(root, "created.txt");
    await saga.effect({
      action: fsAction("write", created),
      args: { op: "write", path: created, realpath: created },
      capturePreimage: captureFs(created),
      run: async () => {
        writeFileSync(created, "fresh");
        return { ok: true };
      },
    });
    const createReceipt = await lastReceipt(v, saga.id);
    expect(createReceipt.preimage?.kind).toBe("fs_absent");
    const createPlan = compileBuiltin(createReceipt);
    await executeStep(createPlan.steps[0]!, {
      receipt: createReceipt,
      attempt_id: newAttemptId(),
      ledger: v.ledgerHandle,
    });
    expect(existsSync(created)).toBe(false);

    const doomed = join(root, "doomed.txt");
    writeFileSync(doomed, "keep-me");
    await saga.effect({
      action: fsAction("unlink", doomed),
      args: { op: "unlink", path: doomed, realpath: doomed },
      capturePreimage: captureFs(doomed),
      run: async () => {
        unlinkSync(doomed);
        return { ok: true };
      },
    });
    const unlinkReceipt = await lastReceipt(v, saga.id);
    const unlinkPlan = compileBuiltin(unlinkReceipt);
    await executeStep(unlinkPlan.steps[0]!, {
      receipt: unlinkReceipt,
      attempt_id: newAttemptId(),
      ledger: v.ledgerHandle,
    });
    expect(readFileSync(doomed, "utf8")).toBe("keep-me");

    const dir = join(root, "newdir");
    await saga.effect({
      action: fsAction("mkdir", dir),
      args: { op: "mkdir", path: dir, realpath: dir },
      capturePreimage: captureFs(dir),
      run: async () => {
        mkdirSync(dir);
        return { ok: true };
      },
    });
    const mkdirReceipt = await lastReceipt(v, saga.id);
    const mkdirPlan = compileBuiltin(mkdirReceipt);
    await executeStep(mkdirPlan.steps[0]!, {
      receipt: mkdirReceipt,
      attempt_id: newAttemptId(),
      ledger: v.ledgerHandle,
    });
    expect(existsSync(dir)).toBe(false);

    const from = join(root, "from.txt");
    const to = join(root, "to.txt");
    writeFileSync(from, "moved");
    await saga.effect({
      action: fsAction("rename", from),
      args: { op: "rename", path: from, from, to, realpath: from },
      capturePreimage: captureFs(from),
      run: async () => {
        renameSync(from, to);
        return { ok: true };
      },
    });
    const renameReceipt = await lastReceipt(v, saga.id);
    const renamePlan = compileBuiltin(renameReceipt);
    expect(renamePlan.steps[0]?.kind).toBe("fs_rename");
    await executeStep(renamePlan.steps[0]!, {
      receipt: renameReceipt,
      attempt_id: newAttemptId(),
      ledger: v.ledgerHandle,
    });
    expect(readFileSync(from, "utf8")).toBe("moved");
    expect(existsSync(to)).toBe(false);

    const modeFile = join(root, "mode.txt");
    writeFileSync(modeFile, "perm");
    chmodSync(modeFile, 0o644);
    const origMode = lstatSync(modeFile).mode & 0o777;
    await saga.effect({
      action: fsAction("chmod", modeFile),
      args: { op: "chmod", path: modeFile, realpath: modeFile },
      capturePreimage: captureFs(modeFile),
      run: async () => {
        chmodSync(modeFile, 0o600);
        return { ok: true };
      },
    });
    const chmodReceipt = await lastReceipt(v, saga.id);
    const chmodPlan = compileBuiltin(chmodReceipt);
    await executeStep(chmodPlan.steps[0]!, {
      receipt: chmodReceipt,
      attempt_id: newAttemptId(),
      ledger: v.ledgerHandle,
    });
    expect(readFileSync(modeFile, "utf8")).toBe("perm");
    expect(lstatSync(modeFile).mode & 0o777).toBe(origMode);

    rmSync(root, { recursive: true, force: true });
  });

  it("dev,ino change is VR5009 and does not write", async () => {
    const root = mkdtempSync(join(tmpdir(), "vr-fs-id-"));
    const v = new VekRevert({
      ledger: "memory",
      writableRoots: [root],
      ledgerOpts: { anchorEvery: 1_000_000, anchorIntervalMs: 86_400_000 },
    });
    const saga = await v.openSaga({ key: "fs-identity" });
    const path = join(root, "id.txt");
    writeFileSync(path, "original");
    await saga.effect({
      action: fsAction("write", path),
      args: { op: "write", path, realpath: path },
      capturePreimage: captureFs(path),
      run: async () => {
        writeFileSync(path, "mutated-in-place");
        return { ok: true };
      },
    });
    const receipt = await lastReceipt(v, saga.id);
    expect(receipt.preimage?.meta?.ino).toBeTypeOf("number");
    expect(receipt.preimage?.meta?.dev).toBeTypeOf("number");
    const plan = compileBuiltin(receipt);
    const other = `${path}.other`;
    writeFileSync(other, "replacement");
    expect(Number(lstatSync(other).ino)).not.toBe(Number(receipt.preimage?.meta?.ino));
    renameSync(other, path);
    const before = readFileSync(path, "utf8");
    await expect(
      executeStep(plan.steps[0]!, {
        receipt,
        attempt_id: newAttemptId(),
        ledger: v.ledgerHandle,
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof VekRevertError && err.code === "VR5009");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readFileSync(path, "utf8")).toBe("replacement");
    rmSync(root, { recursive: true, force: true });
  });
});
