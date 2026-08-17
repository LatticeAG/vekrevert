-- dialect-templated. {{TEXT}} {{INTEGER}} {{BLOB}} substituted per driver.
-- SQLite: TEXT / INTEGER / BLOB. Postgres: text / bigint / bytea.

CREATE TABLE receipt_events (
  id          {{TEXT}} PRIMARY KEY,
  saga_id     {{TEXT}} NOT NULL,
  chain_seq   {{INTEGER}} NOT NULL,
  type        {{TEXT}} NOT NULL,
  ts          {{TEXT}} NOT NULL,
  effect_id   {{TEXT}},
  actor_kind  {{TEXT}} NOT NULL,
  actor_id    {{TEXT}} NOT NULL,
  payload     {{TEXT}} NOT NULL,
  prev_hash   {{TEXT}} NOT NULL,
  hash        {{TEXT}} NOT NULL,
  sig         {{TEXT}},
  UNIQUE (saga_id, chain_seq)
);
CREATE INDEX idx_events_effect ON receipt_events (effect_id);
CREATE INDEX idx_events_type_ts ON receipt_events (type, ts);

{{RECEIPT_EVENTS_IMMUTABLE}}

CREATE TABLE sagas (
  saga_id {{TEXT}} PRIMARY KEY, key {{TEXT}}, agent_id {{TEXT}}, status {{TEXT}} NOT NULL,
  next_seq {{INTEGER}} NOT NULL DEFAULT 1, chain_head {{TEXT}} NOT NULL, chain_len {{INTEGER}} NOT NULL DEFAULT 0,
  opened_at {{TEXT}} NOT NULL, closed_at {{TEXT}},
  UNIQUE (key)
);

CREATE TABLE effects (
  effect_id {{TEXT}} PRIMARY KEY,
  saga_id {{TEXT}} NOT NULL REFERENCES sagas(saga_id),
  seq {{INTEGER}} NOT NULL,
  compensation_of {{TEXT}}, restore_sibling_of {{TEXT}}, parent_effect_id {{TEXT}},
  action_kind {{TEXT}} NOT NULL, action_name {{TEXT}} NOT NULL, action_target {{TEXT}}, locality {{TEXT}} NOT NULL,
  tier {{TEXT}} NOT NULL, classification {{TEXT}} NOT NULL,
  args_observed {{TEXT}} NOT NULL, args_hash {{TEXT}} NOT NULL, args_commitments {{TEXT}}, intent_key {{TEXT}} NOT NULL,
  result_observed {{TEXT}}, result_hash {{TEXT}},
  bindings {{TEXT}} NOT NULL, binding_paths {{TEXT}} NOT NULL, resource_keys {{TEXT}} NOT NULL,
  preimage_kind {{TEXT}}, preimage_blob_id {{TEXT}}, preimage_bytes {{INTEGER}}, preimage_rows {{INTEGER}},
  preimage_truncated {{INTEGER}} NOT NULL DEFAULT 0, preimage_meta {{TEXT}},
  status {{TEXT}} NOT NULL, compensation_state {{TEXT}} NOT NULL, compensator_id {{TEXT}},
  capture_fidelity {{TEXT}} NOT NULL, capture_interceptor {{TEXT}} NOT NULL, capture_warnings {{TEXT}},
  leak {{TEXT}} NOT NULL, cascade_risk {{TEXT}} NOT NULL, compensable_until {{TEXT}},
  opened_at {{TEXT}} NOT NULL, closed_at {{TEXT}}, duration_ms {{INTEGER}},
  redactions {{TEXT}}, sealed {{INTEGER}} NOT NULL DEFAULT 0, seal_hash {{TEXT}},
  UNIQUE (saga_id, seq)
);
CREATE INDEX idx_effects_undo ON effects (saga_id, seq DESC, compensation_state);
CREATE INDEX idx_effects_intent ON effects (saga_id, intent_key);

CREATE TABLE plans (
  plan_id {{TEXT}} PRIMARY KEY, effect_id {{TEXT}} NOT NULL REFERENCES effects(effect_id),
  saga_id {{TEXT}} NOT NULL, compensator_id {{TEXT}} NOT NULL, origin {{TEXT}} NOT NULL,
  steps {{TEXT}} NOT NULL, plan_hash {{TEXT}} NOT NULL, postconditions {{TEXT}} NOT NULL,
  reversal_completeness {{TEXT}} NOT NULL, leak {{TEXT}} NOT NULL, cascade_risk {{TEXT}} NOT NULL,
  summary {{TEXT}} NOT NULL, verification {{TEXT}}, created_at {{TEXT}} NOT NULL,
  UNIQUE (effect_id, plan_hash)
);

CREATE TABLE attempts (
  attempt_id {{TEXT}} PRIMARY KEY, idempotency_key {{TEXT}} NOT NULL UNIQUE,
  effect_id {{TEXT}} NOT NULL, plan_id {{TEXT}} NOT NULL, step_index {{INTEGER}} NOT NULL,
  fence {{INTEGER}} NOT NULL, state {{TEXT}} NOT NULL,
  started_at {{TEXT}} NOT NULL, finished_at {{TEXT}}, error_code {{TEXT}}, response_hash {{TEXT}}
);

CREATE TABLE leases (
  resource_key {{TEXT}} PRIMARY KEY, holder {{TEXT}} NOT NULL,
  acquired_at {{TEXT}} NOT NULL, expires_at {{TEXT}} NOT NULL, fence {{INTEGER}} NOT NULL
);
CREATE INDEX idx_leases_expiry ON leases (expires_at);

CREATE TABLE blobs (
  blob_id {{TEXT}} PRIMARY KEY,
  bytes {{INTEGER}} NOT NULL, created_at {{TEXT}} NOT NULL, refcount {{INTEGER}} NOT NULL DEFAULT 1,
  storage {{TEXT}} NOT NULL,
  inline {{BLOB}}, path {{TEXT}}
);

CREATE TABLE compensators (
  id {{TEXT}} PRIMARY KEY, manifest {{TEXT}} NOT NULL, source {{TEXT}} NOT NULL,
  match_kind {{TEXT}} NOT NULL, specificity {{INTEGER}} NOT NULL,
  signature {{TEXT}}, registered_at {{TEXT}} NOT NULL, disabled {{INTEGER}} NOT NULL DEFAULT 0
);

CREATE TABLE escalations (
  escalation_id {{TEXT}} PRIMARY KEY, effect_id {{TEXT}} NOT NULL, saga_id {{TEXT}} NOT NULL,
  reason_code {{TEXT}} NOT NULL, priority {{TEXT}} NOT NULL,
  vekinbox_request_id {{TEXT}}, vekinbox_key {{TEXT}} NOT NULL UNIQUE,
  approval_binds_to {{TEXT}}, status {{TEXT}} NOT NULL,
  payload {{TEXT}} NOT NULL, raised_at {{TEXT}} NOT NULL, resolved_at {{TEXT}}, resolved_by {{TEXT}}, resolution {{TEXT}}
);

CREATE TABLE anchors (
  anchor_seq {{INTEGER}} PRIMARY KEY, merkle_root {{TEXT}} NOT NULL, saga_heads {{TEXT}} NOT NULL,
  prev_anchor_hash {{TEXT}} NOT NULL, hash {{TEXT}} NOT NULL, sig {{TEXT}}, anchored_at {{TEXT}} NOT NULL
);
