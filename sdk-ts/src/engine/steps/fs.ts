/** fs_restore / fs_rename. Identity guard (dev,ino) + O_NOFOLLOW on the final component. */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { VekRevertError, type CompensationStep, type JsonValue } from "@latticeag/vekrevert-core";
import type { StepContext, StepResult } from "../step.ts";

const O_NOFOLLOW =
  (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ??
  (constants as { UV_FS_O_NOFOLLOW?: number }).UV_FS_O_NOFOLLOW ??
  0;

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, JsonValue>;
  return {};
}

function stringify(v: JsonValue | undefined): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function num(v: string | number | undefined): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function lstatNoFollow(path: string): Stats {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new VekRevertError("VR5009", "symlink at final component");
  return st;
}

function resolveTarget(path: string): string {
  const parentRaw = dirname(path);
  const parent = existsSync(parentRaw) ? realpathSync(parentRaw) : parentRaw;
  return join(parent, basename(path));
}

function assertIdentity(path: string, ctx: StepContext): Stats | undefined {
  if (!existsSync(path)) return undefined;
  if (O_NOFOLLOW) {
    try {
      const fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
      closeSync(fd);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ELOOP" || code === "EPERM") throw new VekRevertError("VR5009", "O_NOFOLLOW");
    }
  }
  const st = lstatNoFollow(path);
  const meta = ctx.receipt.preimage?.meta;
  if (meta && ctx.receipt.preimage?.kind !== "fs_absent") {
    const dev = num(meta.dev);
    const ino = num(meta.ino);
    const stDev = Number(st.dev);
    const stIno = Number(st.ino);
    if (dev !== undefined && stDev !== dev) {
      throw new VekRevertError("VR5009", "identity_changed");
    }
    if (ino !== undefined && stIno !== ino) {
      throw new VekRevertError("VR5009", "identity_changed");
    }
  }
  return st;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadBlob(ctx: StepContext): Promise<Uint8Array> {
  const blobId = ctx.receipt.preimage?.blob_id;
  if (!blobId) throw new VekRevertError("VR3006", "receipt.preimage.blob");
  if (!ctx.ledger) throw new VekRevertError("VR2002", "ledger required to load preimage blob");
  const bytes = await ctx.ledger.getBlob(blobId);
  if (!bytes) throw new VekRevertError("VR2006", blobId);
  return bytes;
}

function writeAtomic(target: string, bytes: Uint8Array, attemptId: string, restoreMeta: boolean, ctx: StepContext): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.vr-restore-${attemptId}-${basename(target)}`);
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  if (restoreMeta) {
    const mode = num(ctx.receipt.preimage?.meta?.mode);
    if (mode !== undefined) chmodSync(target, mode & 0o7777);
  }
}

export async function executeFs(step: CompensationStep, resolved: JsonValue, ctx: StepContext): Promise<StepResult> {
  const rec = asRecord(resolved);
  if (step.kind === "fs_rename") {
    const from = resolveTarget(stringify(rec.from));
    const to = resolveTarget(stringify(rec.to));
    assertIdentity(from, ctx);
    renameSync(from, to);
    return { ok: true, kind: "fs_rename", path: to };
  }
  if (step.kind !== "fs_restore") {
    throw new VekRevertError("VR5001", `expected fs step, got ${step.kind}`);
  }
  const target = resolveTarget(stringify(rec.path));
  const absent = step.source.$ref === "receipt.preimage.absent";
  if (absent) {
    if (!existsSync(target)) return { ok: true, kind: "fs_restore", path: target, absent: true };
    const st = lstatNoFollow(target);
    if (st.isDirectory()) {
      try {
        rmdirSync(target);
      } catch (err) {
        throw new VekRevertError("VR5001", err instanceof Error ? err.message : "rmdir failed");
      }
      return { ok: true, kind: "fs_restore", path: target, absent: true };
    }
    unlinkSync(target);
    return { ok: true, kind: "fs_restore", path: target, absent: true };
  }

  assertIdentity(target, ctx);
  const bytes = await loadBlob(ctx);
  writeAtomic(target, bytes, ctx.attempt_id, step.restore_meta === true, ctx);
  const got = sha256(readFileSync(target));
  const want = ctx.receipt.preimage?.meta?.sha256;
  if (typeof want === "string" && want !== got) {
    throw new VekRevertError("VR5002", "file_hash");
  }
  return { ok: true, kind: "fs_restore", path: target, sha256: got };
}
