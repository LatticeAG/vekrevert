/** instrumentFs: patch write/unlink/mkdir/rename/chmod. Capture preimage before write. Fidelity full. */

import * as nodeFs from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { classifyAction, type ActionRef, type JsonValue } from "@latticeag/vekrevert-core";
import { closeEffect, openEffect, preflightPolicyLocal, type EffectHost } from "../effect.ts";

type FsModule = typeof import("node:fs");
type FsPromises = typeof import("node:fs/promises");

/**
 * Disposable returned by {@link instrumentFs}.
 */
export interface FsInstrumentation extends Disposable {
  /**
   * The patched fs module object.
   *
   * Node's ESM loader snapshots builtins at instantiation: calls made through
   * `import { writeFileSync } from "node:fs"` or `import * as fs` bound
   * *before* instrumentation bypass the patch no matter what we do. Route
   * those call sites through this object (or use the default
   * `import fs from "node:fs"` / `require("node:fs")`, which share it) so
   * writes stay captured.
   */
  module: FsModule;
}

/**
 * `import * as nodeFs` is a read-only module namespace under ESM — assigning
 * to it throws `Cannot assign to read only property 'writeFileSync'`. The
 * underlying CommonJS exports object is mutable and shared across
 * `require("node:fs")` and the ESM default import, so resolve and patch that.
 * Under CJS runtimes the import namespace is that same object already.
 */
function resolveFsPatchTarget(fallback: FsModule): FsModule {
  try {
    const req = createRequire(import.meta.url);
    const shared = req("node:fs") as FsModule | undefined;
    if (shared) return shared;
  } catch {
    /* createRequire unavailable (bundled/non-Node runtime): fall through */
  }
  return fallback;
}

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

export function instrumentFs(host: EffectHost, opts?: { module?: FsModule }): FsInstrumentation {
  const fs = opts?.module ?? resolveFsPatchTarget(nodeFs);
  // Raw references restore the module byte-for-byte on dispose; bound copies
  // drive the real calls from inside the wrappers.
  const raw = {
    writeFileSync: fs.writeFileSync,
    writeFile: fs.writeFile,
    unlinkSync: fs.unlinkSync,
    unlink: fs.unlink,
    mkdirSync: fs.mkdirSync,
    mkdir: fs.mkdir,
    renameSync: fs.renameSync,
    rename: fs.rename,
    chmodSync: fs.chmodSync,
    chmod: fs.chmod,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    lstatSync: fs.lstatSync,
    realpathSync: fs.realpathSync,
  };
  const orig = {
    writeFileSync: raw.writeFileSync.bind(fs),
    writeFile: raw.writeFile.bind(fs),
    unlinkSync: raw.unlinkSync.bind(fs),
    unlink: raw.unlink.bind(fs),
    mkdirSync: raw.mkdirSync.bind(fs),
    mkdir: raw.mkdir.bind(fs),
    renameSync: raw.renameSync.bind(fs),
    rename: raw.rename.bind(fs),
    chmodSync: raw.chmodSync.bind(fs),
    chmod: raw.chmod.bind(fs),
    existsSync: raw.existsSync.bind(fs),
    readFileSync: raw.readFileSync.bind(fs),
    lstatSync: raw.lstatSync.bind(fs),
    realpathSync: raw.realpathSync.bind(fs),
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
  const rawP = promises
    ? {
        writeFile: promises.writeFile,
        unlink: promises.unlink,
        mkdir: promises.mkdir,
        rename: promises.rename,
        chmod: promises.chmod,
      }
    : undefined;
  const origP = rawP
    ? {
        writeFile: rawP.writeFile.bind(promises),
        unlink: rawP.unlink.bind(promises),
        mkdir: rawP.mkdir.bind(promises),
        rename: rawP.rename.bind(promises),
        chmod: rawP.chmod.bind(promises),
      }
    : undefined;

  const dispose = (): void => {
    fs.writeFileSync = raw.writeFileSync;
    fs.writeFile = raw.writeFile;
    fs.unlinkSync = raw.unlinkSync;
    fs.unlink = raw.unlink;
    fs.mkdirSync = raw.mkdirSync;
    fs.mkdir = raw.mkdir;
    fs.renameSync = raw.renameSync;
    fs.rename = raw.rename;
    fs.chmodSync = raw.chmodSync;
    fs.chmod = raw.chmod;
    if (promises && rawP) {
      promises.writeFile = rawP.writeFile;
      promises.unlink = rawP.unlink;
      promises.mkdir = rawP.mkdir;
      promises.rename = rawP.rename;
      promises.chmod = rawP.chmod;
    }
  };

  try {
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
  } catch (err) {
    try {
      dispose();
    } catch {
      /* best-effort restore before rethrow */
    }
    throw new Error(
      "instrumentFs: could not patch node:fs (module object is read-only — " +
        "an ESM module namespace was supplied). Calls through " +
        '`import fs from "node:fs"` (default import) or `require("node:fs")` ' +
        "are intercepted; ESM named/namespace imports " +
        '(`import { writeFileSync } from "node:fs"`, `import * as fs`) ' +
        "snapshot functions at load time and cannot be intercepted — route " +
        "them through `instrumentation.module`, or capture explicitly with " +
        "`saga.effect({ capturePreimage })`.",
      { cause: err },
    );
  }

  return { [Symbol.dispose]: dispose, module: fs };
}
