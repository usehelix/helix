-- Gene Registry Cloud — schema v2
-- Adds api_layer column to split capsules by API sub-layer.
-- e.g. Circle has wallets-api (concurrency lock) vs gateway (throughput window),
-- which need OPPOSITE strategies — same failure_code, different api_layer.

ALTER TABLE capsules ADD COLUMN api_layer TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_capsules_api_layer
  ON capsules(failure_code, category, platform, api_layer);
