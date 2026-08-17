/** C3 cmp_http_create@1: DELETE a REST create. Matches only when delete_undoes_create is true. */

import type { ActionSignature } from "@latticeag/vekrevert-core";

/**
 * Built-in REST create compensator. The signature itself sets delete_undoes_create: true
 * so it matches POST/PUT 200/201/202. A custom manifest that omits that flag will not
 * match this builtin; VekRevert will not guess a DELETE.
 */
export const httpCreate: ActionSignature = {
  id: "cmp_http_create@1",
  match: { kind: "http", method: ["POST", "PUT"], url_pattern: "*" },
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
  source: "builtin",
  delete_undoes_create: true,
  probe: true,
};
