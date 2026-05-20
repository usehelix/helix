import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, needsMigration, getSchemaVersion, CURRENT_SCHEMA_VERSION, migrations } from '../src/engine/migrations.js';

describe('Schema Migrations', () => {
  let db: Database.Database;

  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('fresh database needs migration', () => {
    const check = needsMigration(db);
    expect(check.needed).toBe(true);
    expect(check.currentVersion).toBe(0);
    expect(check.targetVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('runs all migrations on fresh database', () => {
    const applied = runMigrations(db);
    expect(applied.length).toBe(migrations.length);
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('does not re-run migrations', () => {
    runMigrations(db);
    const applied = runMigrations(db);
    expect(applied.length).toBe(0);
  });

  it('needsMigration returns false after migration', () => {
    runMigrations(db);
    expect(needsMigration(db).needed).toBe(false);
  });

  it('creates genes table', () => {
    runMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    expect(tables.map((t: any) => t.name)).toContain('genes');
  });

  it('creates gene_meta table', () => {
    runMigrations(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gene_meta'").get()).toBeTruthy();
  });

  it('creates gene_discoveries table', () => {
    runMigrations(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gene_discoveries'").get()).toBeTruthy();
  });

  it('migrates from v1 to latest', () => {
    // Simulate v1 database
    db.exec(`CREATE TABLE gene_meta (key TEXT PRIMARY KEY, value TEXT)`);
    db.prepare("INSERT INTO gene_meta (key, value) VALUES ('data_schema_version', '1')").run();
    db.exec(`CREATE TABLE genes (id INTEGER PRIMARY KEY, failure_code TEXT, category TEXT, strategy TEXT, q_value REAL DEFAULT 0.5, success_count INTEGER DEFAULT 0, consecutive_failures INTEGER DEFAULT 0, avg_repair_ms REAL DEFAULT 0, platforms TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')), last_used_at TEXT DEFAULT (datetime('now')), UNIQUE(failure_code, category))`);

    expect(needsMigration(db).currentVersion).toBe(1);
    const applied = runMigrations(db);
    expect(applied.length).toBe(CURRENT_SCHEMA_VERSION - 1);
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('Q-value decay on major version jump', () => {
    db.exec(`CREATE TABLE gene_meta (key TEXT PRIMARY KEY, value TEXT)`);
    db.prepare("INSERT INTO gene_meta (key, value) VALUES ('data_schema_version', '1')").run();
    db.exec(`CREATE TABLE genes (id INTEGER PRIMARY KEY, failure_code TEXT, category TEXT, strategy TEXT, q_value REAL DEFAULT 0.8, success_count INTEGER DEFAULT 5, consecutive_failures INTEGER DEFAULT 0, avg_repair_ms REAL DEFAULT 0, platforms TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')), last_used_at TEXT DEFAULT (datetime('now')), UNIQUE(failure_code, category))`);
    db.prepare("INSERT INTO genes (failure_code, category, strategy, q_value) VALUES ('test', 'test', 'retry', 0.8)").run();

    runMigrations(db, { decayOnMajorBump: true });
    const gene = db.prepare("SELECT q_value FROM genes WHERE failure_code = 'test'").get() as any;
    expect(gene.q_value).toBeLessThan(0.8);
    // Lower bound asserts "decay doesn't wipe q to zero" — 0.1 is robust to migration count growth
    // (0.9^N where N = total migrations applied; at N=14 ≈ 0.23, at N=20 ≈ 0.12, at N=30 ≈ 0.04).
    expect(gene.q_value).toBeGreaterThan(0.1);
  });

  it('migrations are idempotent', () => {
    runMigrations(db);
    for (const m of migrations) {
      expect(() => m.up(db)).not.toThrow();
    }
  });

  it('CURRENT_SCHEMA_VERSION matches last migration', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(migrations[migrations.length - 1].version);
  });
});
