/**
 * Gene Map Schema Migrations (Data Versioning)
 *
 * Standalone migration system using gene_meta table.
 * Works alongside existing schema_version table.
 * Each migration is idempotent (safe to run twice).
 */

import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

export const CURRENT_SCHEMA_VERSION = 18;

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Base schema — genes table with Q-value RL',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS genes (id INTEGER PRIMARY KEY AUTOINCREMENT, failure_code TEXT NOT NULL, category TEXT NOT NULL, strategy TEXT NOT NULL, params TEXT DEFAULT '{}', q_value REAL DEFAULT 0.5, success_count INTEGER DEFAULT 0, consecutive_failures INTEGER DEFAULT 0, avg_repair_ms REAL DEFAULT 0, platforms TEXT DEFAULT '[]', reasoning TEXT, failure_analysis TEXT DEFAULT '[]', success_context TEXT DEFAULT '{}', failure_context TEXT DEFAULT '{}', scores TEXT DEFAULT '{}', q_variance REAL DEFAULT 0.25, q_count INTEGER DEFAULT 0, last_5_rewards TEXT DEFAULT '[]', last_success_at INTEGER, last_failed_at INTEGER, created_at TEXT DEFAULT (datetime('now')), last_used_at TEXT DEFAULT (datetime('now')), UNIQUE(failure_code, category))`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_genes_lookup ON genes(failure_code, category)`);
    },
  },
  {
    version: 2,
    description: 'Gene Dream — gene_meta table for dream state',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS gene_meta (key TEXT PRIMARY KEY, value TEXT)`);
      const addCol = (col: string, type: string, def: string) => { try { db.exec(`ALTER TABLE genes ADD COLUMN ${col} ${type} DEFAULT ${def}`); } catch { /* exists */ } };
      addCol('embedding', 'TEXT', 'NULL');
      addCol('dream_cluster', 'TEXT', 'NULL');
      addCol('is_meta_gene', 'INTEGER', '0');
    },
  },
  {
    version: 3,
    description: 'Gene Telemetry — gene_discoveries table',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS gene_discoveries (id INTEGER PRIMARY KEY AUTOINCREMENT, error_pattern TEXT NOT NULL, code TEXT NOT NULL, category TEXT NOT NULL, severity TEXT, strategy TEXT NOT NULL, q_value REAL, source TEXT, reasoning TEXT, llm_provider TEXT, platform TEXT, helix_version TEXT, reported_at INTEGER, reviewed INTEGER DEFAULT 0, approved INTEGER DEFAULT 0, report_count INTEGER DEFAULT 1, avg_q REAL, created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch()))`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_discoveries_unique ON gene_discoveries(code, category, strategy, platform)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_discoveries_reviewed ON gene_discoveries(reviewed)`);
    },
  },
  {
    version: 4,
    description: 'Causal Graph + Negative Knowledge',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS causal_events (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, category TEXT NOT NULL, agent_id TEXT, timestamp INTEGER DEFAULT (unixepoch() * 1000), repaired INTEGER DEFAULT 0, strategy TEXT)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_causal_events_time ON causal_events(timestamp)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_causal_events_code ON causal_events(code, category)`);
      db.exec(`CREATE TABLE IF NOT EXISTS causal_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, from_code TEXT NOT NULL, from_category TEXT NOT NULL, to_code TEXT NOT NULL, to_category TEXT NOT NULL, probability REAL DEFAULT 0, avg_delay_ms REAL DEFAULT 0, observations INTEGER DEFAULT 1, updated_at INTEGER DEFAULT (unixepoch()), UNIQUE(from_code, from_category, to_code, to_category))`);
      db.exec(`CREATE TABLE IF NOT EXISTS anti_patterns (id INTEGER PRIMARY KEY AUTOINCREMENT, failure_code TEXT NOT NULL, category TEXT NOT NULL, strategy TEXT NOT NULL, failure_reasoning TEXT, context_conditions TEXT DEFAULT '{}', observation_count INTEGER DEFAULT 1, created_at INTEGER DEFAULT (unixepoch()), UNIQUE(failure_code, category, strategy))`);
    },
  },
  {
    version: 5,
    description: 'Meta-Learning + Conditional Genes',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS meta_patterns (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern_id TEXT UNIQUE NOT NULL, key_tokens TEXT NOT NULL, strategy TEXT NOT NULL, confidence REAL DEFAULT 0, example_count INTEGER DEFAULT 0, platforms TEXT DEFAULT '[]', created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch()))`);
      const addCol = (col: string, type: string, def: string) => { try { db.exec(`ALTER TABLE genes ADD COLUMN ${col} ${type} DEFAULT ${def}`); } catch {} };
      addCol('conditions', 'TEXT', "'{}'");
      addCol('anti_conditions', 'TEXT', "'{}'");
    },
  },
  {
    version: 6,
    description: 'Adversarial Robustness — 4-layer defense',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS agent_reputation (agent_id TEXT PRIMARY KEY, reputation REAL DEFAULT 0.5, total_reports INTEGER DEFAULT 0, successful_reports INTEGER DEFAULT 0, updated_at INTEGER DEFAULT (unixepoch()))`);
      db.exec(`CREATE TABLE IF NOT EXISTS gene_verifications (id INTEGER PRIMARY KEY AUTOINCREMENT, gene_id INTEGER NOT NULL, agent_id TEXT NOT NULL, success INTEGER NOT NULL, verified_at INTEGER DEFAULT (unixepoch()), UNIQUE(gene_id, agent_id))`);
      db.exec(`CREATE TABLE IF NOT EXISTS gene_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, gene_id INTEGER NOT NULL, q_value REAL NOT NULL, strategy TEXT NOT NULL, params TEXT DEFAULT '{}', snapshot_at INTEGER DEFAULT (unixepoch()))`);
    },
  },
  {
    version: 7,
    description: 'Self-Play Evolution history',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS self_play_history (id INTEGER PRIMARY KEY AUTOINCREMENT, challenge_id TEXT NOT NULL, error_message TEXT NOT NULL, platform TEXT, difficulty TEXT, mutation_type TEXT, strategy_used TEXT, repaired INTEGER DEFAULT 0, verified INTEGER DEFAULT 0, weakness TEXT, played_at INTEGER DEFAULT (unixepoch()))`);
    },
  },
  {
    version: 8,
    description: 'Federated Gene Learning — gradient tables',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS gradient_log (id INTEGER PRIMARY KEY AUTOINCREMENT, failure_code TEXT NOT NULL, category TEXT NOT NULL, strategy TEXT NOT NULL, q_before REAL NOT NULL, q_after REAL NOT NULL, q_delta REAL NOT NULL, recorded_at INTEGER DEFAULT (unixepoch()))`);
      db.exec(`CREATE TABLE IF NOT EXISTS global_gradients (id INTEGER PRIMARY KEY AUTOINCREMENT, failure_code TEXT NOT NULL, category TEXT NOT NULL, strategy TEXT NOT NULL, avg_q_delta REAL NOT NULL, total_samples INTEGER DEFAULT 0, agent_count INTEGER DEFAULT 0, received_at INTEGER DEFAULT (unixepoch()), applied INTEGER DEFAULT 0, UNIQUE(failure_code, category, strategy))`);
      db.exec(`CREATE TABLE IF NOT EXISTS shared_gradients (id INTEGER PRIMARY KEY AUTOINCREMENT, failure_code TEXT NOT NULL, category TEXT NOT NULL, strategy TEXT NOT NULL, q_delta REAL NOT NULL, noise REAL DEFAULT 0, sample_count INTEGER DEFAULT 0, shared_at INTEGER DEFAULT (unixepoch()))`);
    },
  },
  {
    version: 9,
    description: 'Auto Strategy Generation',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS generated_strategies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, description TEXT NOT NULL, action TEXT NOT NULL, override_keys TEXT DEFAULT '[]', override_logic TEXT NOT NULL, confidence REAL DEFAULT 0, gap_code TEXT, validation_score REAL, validated_at INTEGER, active INTEGER DEFAULT 1, created_at INTEGER DEFAULT (unixepoch()))`);
    },
  },
  {
    version: 10,
    description: 'Adaptive Evaluate Weights',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS adaptive_weights (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, dimension TEXT NOT NULL, weight REAL NOT NULL, observations INTEGER DEFAULT 0, updated_at INTEGER DEFAULT (unixepoch()), UNIQUE(category, dimension))`);
      db.exec(`CREATE TABLE IF NOT EXISTS weight_history (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, dimension TEXT NOT NULL, old_weight REAL NOT NULL, new_weight REAL NOT NULL, reason TEXT, recorded_at INTEGER DEFAULT (unixepoch()))`);
    },
  },
  {
    version: 11,
    description: 'Auto Adapter Discovery',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS adapter_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, confidence REAL DEFAULT 0, reason TEXT, error_count INTEGER DEFAULT 0, top_errors TEXT DEFAULT '[]', keywords TEXT DEFAULT '[]', status TEXT DEFAULT 'suggested', created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch()), UNIQUE(platform))`);
      db.exec(`CREATE TABLE IF NOT EXISTS adapter_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, patterns TEXT DEFAULT '[]', source TEXT DEFAULT 'auto-discovered', generated_at INTEGER DEFAULT (unixepoch()))`);
    },
  },
  {
    version: 12,
    description: 'LLM Prompt Optimization — classification tracking (Sprint V2)',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS llm_classifications (id INTEGER PRIMARY KEY AUTOINCREMENT, error_message TEXT NOT NULL, predicted_code TEXT NOT NULL, predicted_category TEXT NOT NULL, predicted_strategy TEXT NOT NULL, actual_outcome TEXT DEFAULT 'unknown', repair_succeeded INTEGER, recorded_at INTEGER DEFAULT (unixepoch()))`);
    },
  },
  {
    version: 13,
    description: 'Token cost tracking — capsules table for API proxy data capture',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS capsules (id TEXT PRIMARY KEY, session_id TEXT, tool_name TEXT, input TEXT, output TEXT, success INTEGER DEFAULT 1, error_type TEXT, repair_strategy TEXT, duration_ms INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), task_type TEXT, token_cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, model TEXT, num_api_calls INTEGER)`);
    },
  },
  {
    version: 14,
    // NOTE: Three parallel Gene Map implementations exist (packages/gene-map,
    // packages/core, packages/vial-core). This change applied to gene-map + core.
    // vial-core is vestigial (zero test coverage, one self-import). Cleanup tracked separately.
    description: 'api_layer — split capsules by API sub-layer (Circle Wallets vs Gateway, etc.)',
    up: (db) => {
      // v14: add api_layer column + change unique key to (failure_code, category, api_layer).
      // SQLite can't ALTER UNIQUE constraints, so recreate the genes table.
      // NULL handling: UNIQUE INDEX with COALESCE so NULL api_layer rows still
      // dedup against each other (NULL != NULL by default in SQL).

      // Idempotent: skip entirely if api_layer already exists (re-runs are no-ops).
      const existingCols = (db.pragma('table_info(genes)') as { name: string }[]).map(c => c.name);
      if (existingCols.includes('api_layer')) return;

      // Defensive against test envs that create a minimal genes table: only
      // copy columns that actually exist in the source.
      const copyableCols = [
        'id', 'failure_code', 'category', 'strategy', 'params',
        'q_value', 'success_count', 'consecutive_failures', 'avg_repair_ms',
        'platforms', 'reasoning', 'failure_analysis', 'success_context',
        'failure_context', 'scores', 'q_variance', 'q_count', 'last_5_rewards',
        'last_success_at', 'last_failed_at', 'created_at', 'last_used_at',
        'embedding', 'dream_cluster', 'is_meta_gene', 'conditions', 'anti_conditions',
      ];
      const selectCols = copyableCols.filter(c => existingCols.includes(c));
      const insertCols = [...selectCols, 'api_layer'];

      db.exec(`CREATE TABLE IF NOT EXISTS genes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        failure_code TEXT NOT NULL,
        category TEXT NOT NULL,
        strategy TEXT NOT NULL,
        params TEXT DEFAULT '{}',
        q_value REAL DEFAULT 0.5,
        success_count INTEGER DEFAULT 0,
        consecutive_failures INTEGER DEFAULT 0,
        avg_repair_ms REAL DEFAULT 0,
        platforms TEXT DEFAULT '[]',
        reasoning TEXT,
        failure_analysis TEXT DEFAULT '[]',
        success_context TEXT DEFAULT '{}',
        failure_context TEXT DEFAULT '{}',
        scores TEXT DEFAULT '{}',
        q_variance REAL DEFAULT 0.25,
        q_count INTEGER DEFAULT 0,
        last_5_rewards TEXT DEFAULT '[]',
        last_success_at INTEGER,
        last_failed_at INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        last_used_at TEXT DEFAULT (datetime('now')),
        embedding TEXT,
        dream_cluster TEXT,
        is_meta_gene INTEGER DEFAULT 0,
        conditions TEXT DEFAULT '{}',
        anti_conditions TEXT DEFAULT '{}',
        api_layer TEXT DEFAULT NULL
      )`);
      db.exec(`INSERT INTO genes_new (${insertCols.join(',')}) SELECT ${selectCols.join(',')}, NULL FROM genes`);
      db.exec('DROP TABLE genes');
      db.exec('ALTER TABLE genes_new RENAME TO genes');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_genes_lookup ON genes(failure_code, category)`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_genes_unique ON genes(failure_code, category, COALESCE(api_layer, ''))`);
    },
  },
  {
    version: 15,
    description: 'Gene Capsules for coding agent — gene_capsules_coding table',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS gene_capsules_coding (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        failure_code TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'coding',
        pattern TEXT,
        typical_files TEXT,
        issue_keywords TEXT,
        strategy TEXT NOT NULL,
        hint TEXT NOT NULL,
        example_fix TEXT,
        q_value REAL DEFAULT 0.5,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        total_uses INTEGER DEFAULT 0,
        shareable INTEGER DEFAULT 0,
        registry_synced INTEGER DEFAULT 0,
        source_issue_number INTEGER,
        source_repo TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_capsules_coding_failure_code ON gene_capsules_coding(failure_code)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_capsules_coding_q_value ON gene_capsules_coding(q_value DESC)`);
    },
  },
  {
    version: 16,
    description: 'Hint usage counters on coding capsules',
    up: (db) => {
      // ALTERs may fail if the columns already exist (e.g., bootstrapped via the
      // CLI's idempotent ensureSchema in packages/cli/src/pcec/db.ts). Tolerate.
      try { db.exec(`ALTER TABLE gene_capsules_coding ADD COLUMN hint_used_count INTEGER DEFAULT 0`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE gene_capsules_coding ADD COLUMN hint_ignored_count INTEGER DEFAULT 0`); } catch { /* exists */ }
    },
  },
  {
    version: 17,
    description: 'Jira webhook tables — webhook event log + encrypted credentials',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS jira_webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_key TEXT NOT NULL,
        project_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        skip_reason TEXT,
        received_at INTEGER NOT NULL,
        processed_at INTEGER,
        capsule_id TEXT,
        pr_url TEXT,
        pr_number INTEGER,
        error TEXT
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_jira_webhooks_issue_key ON jira_webhooks(issue_key)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_jira_webhooks_status ON jira_webhooks(status)`);

      db.exec(`CREATE TABLE IF NOT EXISTS jira_credentials (
        workspace_id TEXT PRIMARY KEY,
        base_url TEXT NOT NULL,
        email TEXT NOT NULL,
        api_token_encrypted TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
    },
  },
  {
    version: 18,
    description: 'IssueRef metadata on coding capsules (issue_source + issue_id)',
    up: (db) => {
      try { db.exec(`ALTER TABLE gene_capsules_coding ADD COLUMN issue_source TEXT DEFAULT 'github'`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE gene_capsules_coding ADD COLUMN issue_id TEXT`); } catch { /* exists */ }
    },
  },
];

export function getSchemaVersion(db: Database.Database): number {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS gene_meta (key TEXT PRIMARY KEY, value TEXT)`);
    const row = db.prepare("SELECT value FROM gene_meta WHERE key = 'data_schema_version'").get() as any;
    return row ? Number(row.value) : 0;
  } catch { return 0; }
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS gene_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.prepare("INSERT INTO gene_meta (key, value) VALUES ('data_schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
}

export function runMigrations(db: Database.Database, options?: { decayOnMajorBump?: boolean }): Migration[] {
  const currentVersion = getSchemaVersion(db);
  const pending = migrations.filter(m => m.version > currentVersion);
  if (pending.length === 0) return [];

  const applied: Migration[] = [];

  db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
      setSchemaVersion(db, migration.version);
      applied.push(migration);
    }

    if (options?.decayOnMajorBump && pending.length >= 2) {
      const totalDecay = Math.pow(0.9, pending.length);
      try {
        db.prepare('UPDATE genes SET q_value = q_value * ? WHERE q_value > 0.2').run(totalDecay);
      } catch { /* genes table may not exist yet */ }
    }
  })();

  return applied;
}

export function needsMigration(db: Database.Database): { needed: boolean; currentVersion: number; targetVersion: number; pendingCount: number } {
  const currentVersion = getSchemaVersion(db);
  const pending = migrations.filter(m => m.version > currentVersion);
  return { needed: pending.length > 0, currentVersion, targetVersion: CURRENT_SCHEMA_VERSION, pendingCount: pending.length };
}
