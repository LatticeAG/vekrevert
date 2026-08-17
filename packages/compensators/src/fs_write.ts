/** C1 cmp_fs_write@1: restore file writes from a captured pre-image. */

import type {
  ActionSignature,
  ArgValue,
  CompensationStep,
  EffectReceipt,
  JsonValue,
  Postcondition,
} from "@latticeag/vekrevert-core";

const FS_OPS = ["write", "truncate", "unlink", "mkdir", "rename", "chmod"] as const;

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, JsonValue>;
  return {};
}

function str(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function pathRef(receipt: EffectReceipt): ArgValue {
  if (receipt.bindings.path !== undefined) return { $ref: "receipt.bindings.path" };
  return { $ref: "receipt.args.path" };
}

function argRef(receipt: EffectReceipt, name: "from" | "to"): ArgValue {
  if (receipt.bindings[name] !== undefined) return { $ref: `receipt.bindings.${name}` };
  return { $ref: `receipt.args.${name}` };
}

export function planForFs(receipt: EffectReceipt): { steps: CompensationStep[]; postconditions: Postcondition[] } {
  const args = asRecord(receipt.args_observed);
  const op = str(args.op) ?? receipt.action.name.split(".")[1] ?? "";

  if (op === "rename") {
    return {
      steps: [
        {
          kind: "fs_rename",
          from: argRef(receipt, "to"),
          to: argRef(receipt, "from"),
        },
      ],
      postconditions: [{ step_index: 0, kind: "file_hash", expected: true, required: false }],
    };
  }

  const kind = receipt.preimage?.kind;
  const absent = kind === "fs_absent" || op === "mkdir";
  if (absent) {
    return {
      steps: [
        {
          kind: "fs_restore",
          path: pathRef(receipt),
          source: { $ref: "receipt.preimage.absent" },
        },
      ],
      postconditions: [{ step_index: 0, kind: "file_absent", expected: true, required: true }],
    };
  }

  return {
    steps: [
      {
        kind: "fs_restore",
        path: pathRef(receipt),
        source: { $ref: "receipt.preimage.blob" },
        restore_meta: true,
      },
    ],
    postconditions: [{ step_index: 0, kind: "file_hash", expected: true, required: true }],
  };
}

const writeTemplate = planForFs({
  args_observed: { op: "write", path: "/x" },
  bindings: {},
  preimage: { kind: "fs_bytes", truncated: false, blob_id: "blob_synthetic" },
  action: { kind: "fs", name: "fs.write./x", locality: "internal" },
} as unknown as EffectReceipt);

export const fsWrite: ActionSignature = {
  id: "cmp_fs_write@1",
  match: { kind: "fs", op: [...FS_OPS], path_glob: "**" },
  tier: "T2",
  binds: {
    from: { from: "args.from", required: false },
    to: { from: "args.to", required: false },
  },
  preimage: { required: true, kind: "fs_bytes" },
  compensator: {
    kind: "declarative",
    steps: writeTemplate.steps,
    postconditions: writeTemplate.postconditions,
  },
  leak: "none",
  cascade_risk: "low",
  independent: true,
  reversal_completeness: "full",
  source: "builtin",
};
