import { createPrivateKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalize,
  classifyAction,
  type ActionSignature,
  type JsonValue,
} from "@latticeag/vekrevert-core";
import {
  CompensatorRegistry,
  signatureVerifiedForS1,
  verifyManifestSignature,
} from "../sdk-ts/src/registry.ts";

function sampleManifest(id: string): ActionSignature {
  return {
    id,
    match: { kind: "http", method: "POST", url_pattern: "https://signed.example.test/v1/items" },
    applies_when: [{ result_status_in: [200, 201, 202] }, { delete_undoes_create: true }],
    tier: "T3",
    binds: {
      resource_url: { from: "header.Location", required: false },
      id: { from: "result.$.id", required: false },
    },
    compensator: {
      kind: "declarative",
      steps: [
        {
          kind: "http_request",
          method: "DELETE",
          url: { $ref: "receipt.bindings.resource_url" },
          expect: { status_in: [200, 202, 204, 404], treat_404_as_compensated: true },
        },
      ],
      postconditions: [{ step_index: 0, kind: "http_probe_absent", expected: true, required: true }],
    },
    leak: "none",
    cascade_risk: "low",
    reversal_completeness: "full",
    source: "registered",
    delete_undoes_create: true,
    probe: true,
  };
}

function signLikeRegister(manifest: ActionSignature, pem: string): string {
  const { signature: _s, ...rest } = manifest;
  const bytes = Buffer.from(canonicalize(rest as unknown as JsonValue));
  return edSign(null, bytes, createPrivateKey(pem)).toString("base64");
}

const MATCH_ACTION = {
  kind: "http" as const,
  name: "http.POST.signed.example.test/v1/items",
  target: "signed.example.test",
  locality: "external" as const,
};
const MATCH_ARGS = { method: "POST", url: "https://signed.example.test/v1/items" };
const MATCH_RESULT = {
  status: 201,
  id: "it_1",
  headers: { Location: "https://signed.example.test/v1/items/it_1" },
};

describe("registry_signed", () => {
  const ENV_KEYS = [
    "VEKREVERT_VERIFY_KEY",
    "VEKREVERT_SIGNING_KEY",
    "VEKREVERT_API_KEY",
    "VEKREVERT_LEDGER",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const name of ENV_KEYS) {
      if (!(name in saved)) continue;
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
      delete saved[name];
    }
  });

  function setEnv(name: (typeof ENV_KEYS)[number], value: string | undefined): void {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  it("valid Ed25519 signature registers, matches, and uses the S1 verified tier", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
    const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    setEnv("VEKREVERT_VERIFY_KEY", pub);

    const manifest = sampleManifest(`cmp_signed_item@${Date.now()}`);
    manifest.signature = signLikeRegister(manifest, priv);
    expect(verifyManifestSignature(manifest, pub)).toBe(true);
    expect(signatureVerifiedForS1(manifest, true)?.tier).toBe("T3");

    const registry = new CompensatorRegistry({ hosted: true });
    const result = await registry.register(manifest, { force: true });
    expect(result.ok).toBe(true);
    const listed = await registry.get(manifest.id);
    expect(listed?.id).toBe(manifest.id);
    expect(listed?.signature).toBe(manifest.signature);

    const matched = registry.match(MATCH_ACTION, MATCH_ARGS, MATCH_RESULT);
    expect(matched.matched?.id).toBe(manifest.id);
    expect(matched.matched?.tier).toBe("T3");
    expect(matched.matched?.signature).toBeTruthy();

    const rec = classifyAction(MATCH_ACTION, MATCH_ARGS, { manifest: matched.matched ?? undefined });
    expect(rec.sources.some((s) => s.source === "manifest" && s.tier === "T3")).toBe(true);
  });

  it("tampered signature is rejected (VR6003 or VR3005)", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    setEnv("VEKREVERT_VERIFY_KEY", publicKey.export({ type: "spki", format: "pem" }).toString());
    const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const manifest = sampleManifest(`cmp_tampered@${Date.now()}`);
    manifest.signature = signLikeRegister(manifest, priv);
    manifest.leak = "observers";

    const registry = new CompensatorRegistry({ hosted: true, ledger: "https://example.test/v1" });
    const result = await registry.register(manifest, { force: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["VR6003", "VR3005"]).toContain(result.error_code);
    expect(signatureVerifiedForS1(manifest, true)).toBeUndefined();
  });

  it("OSS offline (memory ledger, no VERIFY_KEY) still accepts an unsigned register", async () => {
    setEnv("VEKREVERT_VERIFY_KEY", undefined);
    setEnv("VEKREVERT_SIGNING_KEY", undefined);
    setEnv("VEKREVERT_API_KEY", undefined);
    setEnv("VEKREVERT_LEDGER", "memory");
    const registry = new CompensatorRegistry({ hosted: false });
    const result = await registry.register(sampleManifest(`cmp_unsigned_oss@${Date.now()}`), { force: true });
    expect(result.ok).toBe(true);
  });
});
