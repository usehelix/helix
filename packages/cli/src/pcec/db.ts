import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const HELIX_DIR = path.join(os.homedir(), '.helix');
export const GENE_MAP_DB_PATH = path.join(HELIX_DIR, 'gene-map.db');

/**
 * Create the coding-capsule table if it does not already exist.
 * Idempotent — safe to call on every open.
 */
function ensureSchema(db: Database.Database): void {
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

  // v2: hint-usage counters. Idempotent — ALTER fails silently if columns already exist.
  // (Mirrors packages/core migration #16, but applied here since the CLI manages its own DB.)
  try { db.exec(`ALTER TABLE gene_capsules_coding ADD COLUMN hint_used_count INTEGER DEFAULT 0`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE gene_capsules_coding ADD COLUMN hint_ignored_count INTEGER DEFAULT 0`); } catch { /* already exists */ }

  // v3: Jira webhook tables (mirrors packages/core migration #17).
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
}

/**
 * Open ~/.helix/gene-map.db, creating the dir + schema on first use.
 * Caller is responsible for calling .close() when done.
 */
export function openGeneMap(): Database.Database {
  fs.mkdirSync(HELIX_DIR, { recursive: true });
  const db = new Database(GENE_MAP_DB_PATH);
  db.pragma('journal_mode = WAL');
  ensureSchema(db);
  return db;
}
