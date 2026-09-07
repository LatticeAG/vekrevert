-- Coordinator-only SQLite. Not applied to receipt ledgers (001_init).
-- Per-resource leases, fence high-water, apply claims. No global lock table.

CREATE TABLE IF NOT EXISTS coord_leases (
  resource_key {{TEXT}} PRIMARY KEY,
  holder {{TEXT}} NOT NULL,
  acquired_at {{TEXT}} NOT NULL,
  expires_at {{TEXT}} NOT NULL,
  fence {{INTEGER}} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coord_leases_expiry ON coord_leases (expires_at);

CREATE TABLE IF NOT EXISTS coord_fence_hw (
  resource_key {{TEXT}} PRIMARY KEY,
  fence {{INTEGER}} NOT NULL
);

CREATE TABLE IF NOT EXISTS coord_claims (
  resource_key {{TEXT}} PRIMARY KEY,
  holder {{TEXT}} NOT NULL,
  fence {{INTEGER}} NOT NULL,
  saga_id {{TEXT}} NOT NULL,
  plan_hash {{TEXT}} NOT NULL,
  state {{TEXT}} NOT NULL,
  updated_at {{TEXT}} NOT NULL
);

CREATE TABLE IF NOT EXISTS coord_events (
  id {{TEXT}} PRIMARY KEY,
  saga_id {{TEXT}} NOT NULL,
  chain_seq {{INTEGER}} NOT NULL,
  body {{TEXT}} NOT NULL,
  hash {{TEXT}} NOT NULL,
  UNIQUE (saga_id, chain_seq)
);
CREATE INDEX IF NOT EXISTS idx_coord_events_saga ON coord_events (saga_id, chain_seq);
