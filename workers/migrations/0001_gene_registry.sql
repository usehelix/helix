-- Gene Registry Cloud — schema v1
-- Stores shared Gene Capsules from all connected agents.
-- Pulled from local Gene Map (schema v6) via @vial-agent/gene-map SDK.

CREATE TABLE IF NOT EXISTS capsules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  failure_code TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'generic',
  platform TEXT NOT NULL DEFAULT 'generic',
  strategy TEXT NOT NULL,

  q_value REAL NOT NULL DEFAULT 0.5,
  success_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  avg_repair_ms REAL,

  -- Per-row capsule format version. Bumped when local Gene Map adds new
  -- semantic fields (e.g. context vectors, signed provenance) so future
  -- writers/readers can downgrade gracefully.
  capsule_schema_version INTEGER NOT NULL DEFAULT 1,

  agent_id TEXT,
  sdk_version TEXT,
  chain_id INTEGER,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(failure_code, category, platform, strategy)
);

CREATE INDEX IF NOT EXISTS idx_capsules_lookup
  ON capsules(failure_code, category, platform);

-- Singleton row holding only true cumulative counters that cannot be derived
-- from a live COUNT(*). total_capsules and total_agents are computed live in
-- GET /v1/stats so they stay correct under deletes/cleanup.
CREATE TABLE IF NOT EXISTS registry_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_repairs INTEGER NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO registry_stats (id) VALUES (1);
