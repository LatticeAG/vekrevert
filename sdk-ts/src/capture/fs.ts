/** instrumentFs: patch write/unlink/mkdir/rename/chmod. Capture preimage before write. Fidelity full. */

import * as nodeFs from "node:fs";
import { dirname } from "node:path";
import { classifyAction, type ActionRef, type JsonValue } from "@latticeag/vekrevert-core";
import { closeEffect, openEffect, preflightPolicyLocal, type EffectHost } from "../effect.ts";

type FsModule = typeof import("node:fs");
type FsPromises = typeof import("node:fs/promises");

function asPath(p: unknown): string {
  if (typeof p === "string") return p;
  if (p && typeof p === "object" && "toString" in p) return String(p);
  return String(p);
}

function realpathBest(origReal: (p: string) => string, path: string): string {
  try {
    return origReal(path);
  } catch {
    try {
      return origReal(dirname(path)) + "/" + path.split("/").pop();
    } catch {
      return path;
    }
  }
}

function fsAction(op: string, path: string): ActionRef {
  return { kind: "fs", name: `fs.${op}.${path}`, target: path, locality: "internal" };
}

type PreimageCapture = {
  kind: "fs_absent" | "fs_bytes";
  bytes?: Uint8Array;
  meta: Record<string, string | number>;
  truncated: boolean;
};

function absentPre(path: string): PreimageCapture {
  return { kind: "fs_absent", meta: { realpath: path }, truncated: false };
}

async function runFsAsync<T>(
  host: EffectHost,
  op: string,
  path: string,
  extraArgs: Record<string, JsonValue>,
  capturePreimage: () => PreimageCapture,
  run: () => T | Promise<T>,
): Promise<T> {
  const sagaId = host.currentSagaId;
  if (!sagaId || !host.ledgerHandle) return await run();
  const real = path;
  const args: JsonValue = { op, path, realpath: real, ...extraArgs };
  const opened = await openEffect(host, sagaId, {
    action: fsAction(op, real),
    args,
    run: async () => null,
    capture: { fidelity: "full", interceptor: "instrumentFs" },
    capturePreimage,
  });
  try {
    const value = await run();
    await closeEffect(host, opened, { value: value as never, result: { ok: true } });
    return value;
  } catch (err) {
    try {
      await closeEffect(host, opened, { error: err });
    } catch {
      /* isolation */
    }
    throw err;
  }
}

function preflightSync(host: EffectHost, op: string, path: string, extraArgs: Record<string, JsonValue>, pre: PreimageCapture): void {
  const args: JsonValue = { op, path, realpath: path, ...extraArgs };
  const classification = classifyAction(fsAction(op, path), args, {
    writableRoots: host.config.writableRoots,
    internalHosts: host.config.internalHosts,
    preimage: {
      kind: pre.kind,
      truncated: pre.truncated,
      bytes: pre.bytes?.byteLength,
      meta: pre.meta,
    },
    captureFidelity: "full",
  });
  preflightPolicyLocal(host, classification);
}

function recordAfter(host: EffectHost, op: string, path: string, extraArgs: Record<string, JsonValue>, pre: PreimageCapture, error?: unknown): void {
  const sagaId = host.currentSagaId;
  if (!sagaId || !host.ledgerHandle) return;
  void (async () => {
    const opened = await openEffect(host, sagaId, {
      action: fsAction(op, path),
      args: { op, path, realpath: path, ...extraArgs },
      run: async () => null,
      capture: { fidelity: "full", interceptor: "instrumentFs" },
      capturePreimage: () => pre,
    });
    await closeEffect(host, opened, error ? { error } : { result: { ok: true } });
  })().catch(() => {
    /* isolation */
  });
}

export function instrumentFs(host: EffectHost, opts?: { module?: FsModule }): Disposable {
  const fs = opts?.module ?? nodeFs;
  const orig = {
    writeFileSync: fs.writeFileSync.bind(fs),
    writeFile: fs.writeFile.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
    unlink: fs.unlink.bind(fs),
    mkdirSync: fs.mkdirSync.bind(fs),
    mkdir: fs.mkdir.bind(fs),
    renameSync: fs.renameSync.bind(fs),
    rename: fs.rename.bind(fs),
    chmodSync: fs.chmodSync.bind(fs),
    chmod: fs.chmod.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    readFileSync: fs.readFileSync.bind(fs),
    lstatSync: fs.lstatSync.bind(fs),
    realpathSync: fs.realpathSync.bind(fs),
  };

  const readPre = (path: string): PreimageCapture => {
    if (!orig.existsSync(path)) return absentPre(path);
    try {
      const bytes = new Uint8Array(orig.readFileSync(path));
      const st = orig.lstatSync(path);
      return {
        kind: "fs_bytes",
        bytes,
        truncated: false,
        meta: { realpath: realpathBest(orig.realpathSync, path), mode: st.mode, dev: st.dev, ino: Number(st.ino) },
      };
    } catch {
      return absentPre(path);
    }
  };

  const promises = fs.promises as FsPromises | undefined;
  const origP = promises
    ? {
        writeFile: promises.writeFile.bind(promises),
        unlink: promises.unlink.bind(promises),
        mkdir: promises.mkdir.bind(promises),
        rename: promises.rename.bind(promises),
        chmod: promises.chmod.bind(promises),
      }
    : undefined;

  fs.writeFileSync = ((path: unknown, data: unknown, options?: unknown) => {
    const p = asPath(path);
    const pre = readPre(p);
    preflightSync(host, "write", p, {}, pre);
    try {
      const v = orig.writeFileSync(path as never, data as never, options as never);
      recordAfter(host, "write", p, {}, pre);
      return v;
    } catch (err) {
      recordAfter(host, "write", p, {}, pre, err);
      throw err;
    }
  }) as typeof fs.writeFileSync;

  fs.unlinkSync = ((path: unknown) => {
    const p = asPath(path);
    const pre = readPre(p);
    preflightSync(host, "unlink", p, {}, pre);
    try {
      const v = orig.unlinkSync(path as never);
      recordAfter(host, "unlink", p, {}, pre);
      return v;
    } catch (err) {
      recordAfter(host, "unlink", p, {}, pre, err);
      throw err;
    }
  }) as typeof fs.unlinkSync;

  fs.mkdirSync = ((path: unknown, options?: unknown) => {
    const p = asPath(path);
    const pre = orig.existsSync(p) ? readPre(p) : absentPre(p);
    preflightSync(host, "mkdir", p, {}, pre);
    try {
      const v = orig.mkdirSync(path as never, options as never);
      recordAfter(host, "mkdir", p, {}, pre);
      return v;
    } catch (err) {
      recordAfter(host, "mkdir", p, {}, pre, err);
      throw err;
    }
  }) as typeof fs.mkdirSync;

  fs.renameSync = ((from: unknown, to: unknown) => {
    const src = asPath(from);
    const dest = asPath(to);
    const pre = readPre(src);
    preflightSync(host, "rename", src, { from: src, to: dest }, pre);
    try {
      const v = orig.renameSync(from as never, to as never);
      recordAfter(host, "rename", src, { from: src, to: dest }, pre);
      return v;
    } catch (err) {
      recordAfter(host, "rename", src, { from: src, to: dest }, pre, err);
      throw err;
    }
  }) as typeof fs.renameSync;

  fs.chmodSync = ((path: unknown, mode: unknown) => {
    const p = asPath(path);
    const pre = readPre(p);
    preflightSync(host, "chmod", p, { mode: Number(mode) }, pre);
    try {
      const v = orig.chmodSync(path as never, mode as never);
      recordAfter(host, "chmod", p, { mode: Number(mode) }, pre);
      return v;
    } catch (err) {
      recordAfter(host, "chmod", p, { mode: Number(mode) }, pre, err);
      throw err;
    }
  }) as typeof fs.chmodSync;

  fs.writeFile = ((path: unknown, data: unknown, options: unknown, cb?: unknown) => {
    const p = asPath(path);
    const callback = typeof options === "function" ? options : cb;
    const opts = typeof options === "function" ? undefined : options;
    if (typeof callback === "function") {
      const pre = readPre(p);
      orig.writeFile(path as never, data as never, opts as never, ((err: unknown) => {
        recordAfter(host, "write", p, {}, pre, err ?? undefined);
        (callback as (e: unknown) => void)(err);
      }) as never);
      return;
    }
    return runFsAsync(host, "write", p, {}, () => readPre(p), () => orig.writeFile(path as never, data as never, options as never));
  }) as typeof fs.writeFile;

  fs.unlink = ((path: unknown, cb?: unknown) => {
    const p = asPath(path);
    if (typeof cb === "function") {
      const pre = readPre(p);
      orig.unlink(path as never, ((err: unknown) => {
        recordAfter(host, "unlink", p, {}, pre, err ?? undefined);
        (cb as (e: unknown) => void)(err);
      }) as never);
      return;
    }
    return runFsAsync(host, "unlink", p, {}, () => readPre(p), () =>
      origP ? origP.unlink(path as never) : new Promise((resolve, reject) => {
        orig.unlink(path as never, (err: NodeJS.ErrnoException | null) => (err ? reject(err) : resolve(undefined)));
      }),
    );
  }) as typeof fs.unlink;

  fs.mkdir = ((path: unknown, options?: unknown, cb?: unknown) => {
    const p = asPath(path);
    const callback = typeof options === "function" ? options : cb;
    const opts = typeof options === "function" ? undefined : options;
    if (typeof callback === "function") {
      const pre = orig.existsSync(p) ? readPre(p) : absentPre(p);
      orig.mkdir(path as never, opts as never, callback as never);
      recordAfter(host, "mkdir", p, {}, pre);
      return;
    }
    return runFsAsync(
      host,
      "mkdir",
      p,
      {},
      () => (orig.existsSync(p) ? readPre(p) : absentPre(p)),
      () => orig.mkdir(path as never, options as never),
    );
  }) as typeof fs.mkdir;

  fs.rename = ((from: unknown, to: unknown, cb?: unknown) => {
    const src = asPath(from);
    const dest = asPath(to);
    if (typeof cb === "function") {
      const pre = readPre(src);
      orig.rename(from as never, to as never, cb as never);
      recordAfter(host, "rename", src, { from: src, to: dest }, pre);
      return;
    }
    return runFsAsync(host, "rename", src, { from: src, to: dest }, () => readPre(src), () =>
      origP ? origP.rename(from as never, to as never) : new Promise((resolve, reject) => {
        orig.rename(from as never, to as never, (err: NodeJS.ErrnoException | null) => (err ? reject(err) : resolve(undefined)));
      }),
    );
  }) as typeof fs.rename;

  fs.chmod = ((path: unknown, mode: unknown, cb?: unknown) => {
    const p = asPath(path);
    if (typeof cb === "function") {
      const pre = readPre(p);
      orig.chmod(path as never, mode as never, cb as never);
      recordAfter(host, "chmod", p, { mode: Number(mode) }, pre);
      return;
    }
    return runFsAsync(host, "chmod", p, { mode: Number(mode) }, () => readPre(p), () =>
      origP ? origP.chmod(path as never, mode as never) : new Promise((resolve, reject) => {
        orig.chmod(path as never, mode as never, (err: NodeJS.ErrnoException | null) => (err ? reject(err) : resolve(undefined)));
      }),
    );
  }) as typeof fs.chmod;

  if (promises && origP) {
    promises.writeFile = (async (path: unknown, data: unknown, options?: unknown) => {
      const p = asPath(path);
      return runFsAsync(host, "write", p, {}, () => readPre(p), () => origP.writeFile(path as never, data as never, options as never));
    }) as typeof promises.writeFile;
    promises.unlink = (async (path: unknown) => {
      const p = asPath(path);
      return runFsAsync(host, "unlink", p, {}, () => readPre(p), () => origP.unlink(path as never));
    }) as typeof promises.unlink;
    promises.mkdir = (async (path: unknown, options?: unknown) => {
      const p = asPath(path);
      return runFsAsync(
        host,
        "mkdir",
        p,
        {},
        () => (orig.existsSync(p) ? readPre(p) : absentPre(p)),
        () => origP.mkdir(path as never, options as never),
      );
    }) as typeof promises.mkdir;
    promises.rename = (async (from: unknown, to: unknown) => {
      const src = asPath(from);
      const dest = asPath(to);
      return runFsAsync(host, "rename", src, { from: src, to: dest }, () => readPre(src), () => origP.rename(from as never, to as never));
    }) as typeof promises.rename;
    promises.chmod = (async (path: unknown, mode: unknown) => {
      const p = asPath(path);
      return runFsAsync(host, "chmod", p, { mode: Number(mode) }, () => readPre(p), () => origP.chmod(path as never, mode as never));
    }) as typeof promises.chmod;
  }

  const dispose = (): void => {
    fs.writeFileSync = orig.writeFileSync;
    fs.writeFile = orig.writeFile;
    fs.unlinkSync = orig.unlinkSync;
    fs.unlink = orig.unlink;
    fs.mkdirSync = orig.mkdirSync;
    fs.mkdir = orig.mkdir;
    fs.renameSync = orig.renameSync;
    fs.rename = orig.rename;
    fs.chmodSync = orig.chmodSync;
    fs.chmod = orig.chmod;
    if (promises && origP) {
      promises.writeFile = origP.writeFile;
      promises.unlink = origP.unlink;
      promises.mkdir = origP.mkdir;
      promises.rename = origP.rename;
      promises.chmod = origP.chmod;
    }
  };

  return { [Symbol.dispose]: dispose };
}
