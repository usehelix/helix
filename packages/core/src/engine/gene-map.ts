import Database from 'better-sqlite3';
import type { ErrorCode, FailureCategory, GeneCapsule, Platform, RepairContext, TraceEntry } from './types.js';
import { SEED_GENES } from './seed-genes.js';
import { GenePredictiveGraph } from './gene-predict.js';
import { runMigrations, needsMigration } from './migrations.js';
import { simplifyContext, getContextArray, contextSimilarity } from './gene-context.js';

function parseRow(row: Record<string, unknown>): GeneCapsule {
  return {
    id: row.id as number,
    failureCode: row.failure_code as ErrorCode,
    category: row.category as FailureCategory,
    strategy: row.strategy as string,
    params: JSON.parse(row.params as string),
    successCount: row.success_count as number,
    avgRepairMs: row.avg_repair_ms as number,
    platforms: JSON.parse(row.platforms as string) as Platform[],
    qValue: row.q_value as number,
    qVariance: (row.q_variance as number) ?? 0.25,
    qCount: (row.q_count as number) ?? 0,
    last5Rewards: row.last_5_rewards ? JSON.parse(row.last_5_rewards as string) : [],
    consecutiveFailures: row.consecutive_failures as number,
    lastSuccessAt: row.last_success_at as number | undefined,
    lastFailedAt: row.last_failed_at as number | undefined,
    createdAt: row.created_at as string,
    lastUsedAt: row.last_used_at as string,
    reasoning: row.reasoning as string | undefined,
    failureAnalysis: row.failure_analysis ? JSON.parse(row.failure_analysis as string) : [],
    successContext: row.success_context ? JSON.parse(row.success_context as string) : {},
    failureContext: row.failure_context ? JSON.parse(row.failure_context as string) : {},
    scores: row.scores ? JSON.parse(row.scores as string) : undefined,
  };
}

// ── Adaptive Learning Rate (Sprint 2) ──

export interface AdaptiveAlphaConfig {
  alphaBase: number;   // base learning rate (default 0.1)
  gamma: number;       // variance sensitivity (default 2.0)
  beta: number;        // count decay (default 0.05)
  alphaMin: number;    // floor (default 0.01)
  alphaMax: number;    // ceiling (default 0.5)
}

const DEFAULT_ALPHA_CONFIG: AdaptiveAlphaConfig = {
  alphaBase: 0.1,
  gamma: 2.0,
  beta: 0.05,
  alphaMin: 0.01,
  alphaMax: 0.5,
};

export function calculateAdaptiveAlpha(
  qCount: number,
  last5Rewards: number[],
  config: AdaptiveAlphaConfig = DEFAULT_ALPHA_CONFIG,
): number {
  const variance = last5Rewards.length >= 2
    ? last5Rewards.reduce((sum, r) => sum + (r - last5Rewards.reduce((a, b) => a + b, 0) / last5Rewards.length) ** 2, 0) / (last5Rewards.length - 1)
    : 0.25; // high variance default for cold start
  const alpha = config.alphaBase * (1 + config.gamma * variance) / (1 + config.beta * qCount);
  return Math.max(config.alphaMin, Math.min(config.alphaMax, alpha));
}

export function thompsonSample(qValue: number, qVariance: number): number {
  // Box-Muller transform for normal sample
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return qValue + z * Math.sqrt(Math.max(qVariance, 0.001));
}

export class GeneMap {
  private static readonly SCHEMA_VERSION = 6;
  private db: Database.Database;
  private stmtLookup!: Database.Statement;
  private stmtUpsert!: Database.Statement;
  private stmtList!: Database.Statement;
  private stmtCount!: Database.Statement;
  private stmtUpdatePlatforms!: Database.Statement;
  private cache: Map<string, Record<string, unknown>> = new Map();
  private cacheLoadedAt = 0;
  private readonly CACHE_TTL_MS = 30_000;
  private predict!: GenePredictiveGraph;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    const mcheck = needsMigration(this.db);
    if (mcheck.needed) {
      const applied = runMigrations(this.db, { decayOnMajorBump: true });
      if (applied.length > 0) console.log(`[helix] Gene Map migrated: v${mcheck.currentVersion} → v${mcheck.targetVersion}`);
    }
    this.ensureSchema();
    this.prepareStatements();
    this.predict = new GenePredictiveGraph(this.db, this.stmtLookup, this.cache, this.cacheKey.bind(this));
    this.seed();
    this.warmCache();
  }

  // ── Schema Versioning (D10) ──

  private ensureSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, migrated_at DATETIME DEFAULT (datetime('now')))`);
    const row = this.db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
    const current = row?.version ?? 0;
    if (current < GeneMap.SCHEMA_VERSION) this.migrate(current);
    this.db.exec(`CREATE TABLE IF NOT EXISTS gene_meta (key TEXT PRIMARY KEY, value TEXT)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS repair_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, agent_id TEXT, error_message TEXT, failure_code TEXT, failure_category TEXT, strategy TEXT, immune INTEGER DEFAULT 0, success INTEGER DEFAULT 0, verify_passed INTEGER DEFAULT 1, mode TEXT, duration_ms INTEGER, q_before REAL, q_after REAL, overrides TEXT, chain_steps TEXT, predictions TEXT, created_at DATETIME DEFAULT (datetime('now')))`);
  }

  private migrate(from: number): void {
    const migrations: Record<number, () => void> = {
      0: () => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS genes (id INTEGER PRIMARY KEY AUTOINCREMENT, failure_code TEXT NOT NULL, category TEXT NOT NULL, strategy TEXT NOT NULL, params TEXT DEFAULT '{}', success_count INTEGER DEFAULT 1, avg_repair_ms REAL DEFAULT 0, platforms TEXT DEFAULT '[]', q_value REAL DEFAULT 0.5, last_success_at INTEGER, last_failed_at INTEGER, consecutive_failures INTEGER DEFAULT 0, reasoning TEXT, failure_analysis TEXT DEFAULT '[]', success_context TEXT DEFAULT '{}', failure_context TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), last_used_at TEXT DEFAULT (datetime('now')), UNIQUE(failure_code, category))`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS repair_log (id INTEGER PRIMARY KEY AUTOINCREMENT, repair_id TEXT UNIQUE NOT NULL, failure_code TEXT NOT NULL, category TEXT NOT NULL, strategy TEXT NOT NULL, status TEXT DEFAULT 'pending', tx_hash TEXT, created_at DATETIME DEFAULT (datetime('now')), completed_at DATETIME)`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS repair_attribution (id INTEGER PRIMARY KEY AUTOINCREMENT, repair_id TEXT NOT NULL, agent_id TEXT NOT NULL, step_id TEXT, workflow TEXT, failure_code TEXT NOT NULL, category TEXT NOT NULL, strategy TEXT, success INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now')))`);
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_attribution_agent ON repair_attribution(agent_id)');
      },
      1: () => {
        const addCol = (t: string, c: string, type: string, def: string) => { try { this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type} DEFAULT ${def}`); } catch { /* exists */ } };
        addCol('genes', 'reasoning', 'TEXT', 'NULL');
        addCol('genes', 'failure_analysis', 'TEXT', "'[]'");
        addCol('genes', 'success_context', 'TEXT', "'{}'");
        addCol('genes', 'failure_context', 'TEXT', "'{}'");
        this.db.exec(`CREATE TABLE IF NOT EXISTS repair_attribution (id INTEGER PRIMARY KEY AUTOINCREMENT, repair_id TEXT NOT NULL, agent_id TEXT NOT NULL, step_id TEXT, workflow TEXT, failure_code TEXT NOT NULL, category TEXT NOT NULL, strategy TEXT, success INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now')))`);
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_attribution_agent ON repair_attribution(agent_id)');
      },
      2: () => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS gene_links (id INTEGER PRIMARY KEY AUTOINCREMENT, gene_a_code TEXT NOT NULL, gene_a_category TEXT NOT NULL, gene_b_code TEXT NOT NULL, gene_b_category TEXT NOT NULL, strength REAL DEFAULT 0.5, co_occurrence_count INTEGER DEFAULT 1, created_at DATETIME DEFAULT (datetime('now')), last_seen_at DATETIME DEFAULT (datetime('now')), UNIQUE(gene_a_code, gene_a_category, gene_b_code, gene_b_category))`);
      },
      3: () => {
        const addCol = (c: string, type: string, def: string) => { try { this.db.exec(`ALTER TABLE genes ADD COLUMN ${c} ${type} DEFAULT ${def}`); } catch { /* exists */ } };
        addCol('q_variance', 'REAL', '0.25');
        addCol('q_count', 'INTEGER', '0');
        addCol('last_5_rewards', 'TEXT', "'[]'");
      },
      4: () => {
        const addCol = (t: string, c: string, type: string, def: string) => { try { this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type} DEFAULT ${def}`); } catch { /* exists */ } };
        addCol('gene_links', 'transition_probability', 'REAL', '0.0');
        addCol('gene_links', 'avg_delay_ms', 'REAL', '0.0');
        addCol('gene_links', 'from_count', 'INTEGER', '0');
      },
      5: () => {
        try { this.db.exec(`ALTER TABLE genes ADD COLUMN scores TEXT DEFAULT '{}'`); } catch { /* exists */ }
        this.db.exec(`CREATE TABLE IF NOT EXISTS failed_repairs (id INTEGER PRIMARY KEY AUTOINCREMENT, failure_code TEXT NOT NULL, category TEXT NOT NULL, strategy TEXT NOT NULL, error TEXT NOT NULL, repair_error TEXT NOT NULL, context TEXT DEFAULT '{}', timestamp INTEGER NOT NULL)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_failed_pattern ON failed_repairs(failure_code, strategy)`);
      },
    };
    this.db.transaction(() => {
      for (let v = from; v < GeneMap.SCHEMA_VERSION; v++) {
        migrations[v]?.();
        this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v + 1);
      }
    })();
  }

  private prepareStatements(): void {
    this.stmtLookup = this.db.prepare(`SELECT * FROM genes WHERE failure_code = ? AND category = ? ORDER BY q_value DESC LIMIT 1`);
    this.stmtUpsert = this.db.prepare(`INSERT INTO genes (failure_code, category, strategy, params, success_count, avg_repair_ms, platforms, q_value, consecutive_failures) VALUES (@failureCode, @category, @strategy, @params, @successCount, @avgRepairMs, @platforms, @qValue, @consecutiveFailures) ON CONFLICT(failure_code, category) DO UPDATE SET strategy = @strategy, params = @params, success_count = success_count + 1, avg_repair_ms = (avg_repair_ms * success_count + @avgRepairMs) / (success_count + 1), platforms = @platforms, q_value = @qValue, consecutive_failures = @consecutiveFailures, last_used_at = datetime('now')`);
    this.stmtList = this.db.prepare(`SELECT * FROM genes ORDER BY q_value DESC, success_count DESC`);
    this.stmtCount = this.db.prepare(`SELECT COUNT(*) as count FROM genes`);
    this.stmtUpdatePlatforms = this.db.prepare(`UPDATE genes SET platforms = ?, last_used_at = datetime('now') WHERE failure_code = ? AND category = ?`);
  }

  // ── L1 Cache ──

  private cacheKey(code: string, category: string): string { return `${code}:${category}`; }
  private warmCache(): void { this.cache.clear(); for (const r of this.db.prepare('SELECT * FROM genes').all() as Record<string, unknown>[]) this.cache.set(this.cacheKey(r.failure_code as string, r.category as string), r); this.cacheLoadedAt = Date.now(); }
  private isCacheStale(): boolean { return Date.now() - this.cacheLoadedAt > this.CACHE_TTL_MS; }

  // ── Core CRUD ──

  lookup(code: ErrorCode, category: FailureCategory, context?: RepairContext): GeneCapsule | null {
    const key = this.cacheKey(code, category);
    let gene: GeneCapsule;
    if (!this.isCacheStale() && this.cache.has(key)) {
      const cached = this.cache.get(key)!;
      this.db.prepare(`UPDATE genes SET last_used_at = datetime('now'), success_count = success_count + 1 WHERE failure_code = ? AND category = ?`).run(code, category);
      gene = parseRow(cached); gene.successCount += 1;
    } else {
      const row = this.stmtLookup.get(code, category) as Record<string, unknown> | undefined;
      if (!row) return null;
      this.db.prepare(`UPDATE genes SET last_used_at = datetime('now'), success_count = success_count + 1 WHERE failure_code = ? AND category = ?`).run(code, category);
      this.cache.set(key, row);
      gene = parseRow(row); gene.successCount += 1;
    }

    if (!context) return gene;

    const similarity = contextSimilarity(gene, context);
    return {
      ...gene,
      qValue: gene.qValue * similarity,
      _originalQValue: gene.qValue,
      _contextSimilarity: similarity,
    };
  }

  addPlatform(code: ErrorCode, category: FailureCategory, platform: Platform): void {
    const row = this.stmtLookup.get(code, category) as Record<string, unknown> | undefined;
    if (!row) return;
    const p: Platform[] = JSON.parse(row.platforms as string);
    if (!p.includes(platform)) { p.push(platform); this.stmtUpdatePlatforms.run(JSON.stringify(p), code, category); this.cache.delete(this.cacheKey(code, category)); }
  }

  store(gene: GeneCapsule): void {
    this.stmtUpsert.run({ failureCode: gene.failureCode, category: gene.category, strategy: gene.strategy, params: JSON.stringify(gene.params, (_k, v) => typeof v === 'bigint' ? v.toString() : v), successCount: gene.successCount, avgRepairMs: gene.avgRepairMs, platforms: JSON.stringify(gene.platforms), qValue: gene.qValue ?? 0.5, consecutiveFailures: gene.consecutiveFailures ?? 0 });
    this.cache.delete(this.cacheKey(gene.failureCode, gene.category));
  }

  recordSuccess(code: string, category: string, repairMs: number, context?: RepairContext): void {
    const row = this.stmtLookup.get(code, category) as Record<string, unknown> | undefined;
    if (!row) return;
    const reward = 1.0;
    const qCount = (row.q_count as number) ?? 0;
    const last5: number[] = row.last_5_rewards ? JSON.parse(row.last_5_rewards as string) : [];
    const alpha = calculateAdaptiveAlpha(qCount, last5);
    const oldQ = row.q_value as number;
    const newQ = oldQ + alpha * (reward - oldQ);
    const newLast5 = [...last5, reward].slice(-5);
    const newVariance = newLast5.length >= 2
      ? newLast5.reduce((s, r) => s + (r - newLast5.reduce((a, b) => a + b, 0) / newLast5.length) ** 2, 0) / (newLast5.length - 1)
      : 0.25;
    this.db.prepare(`UPDATE genes SET q_value = ?, q_variance = ?, q_count = ?, last_5_rewards = ?, avg_repair_ms = (avg_repair_ms * success_count + ?) / (success_count + 1), success_count = success_count + 1, last_success_at = ?, consecutive_failures = 0, last_used_at = datetime('now') WHERE failure_code = ? AND category = ?`).run(newQ, newVariance, qCount + 1, JSON.stringify(newLast5), repairMs, Date.now(), code, category);

    // Store context snapshot
    if (context) {
      const existing = getContextArray(row.success_context as string);
      existing.push(simplifyContext(context));
      if (existing.length > 10) existing.shift();
      this.db.prepare('UPDATE genes SET success_context = ? WHERE failure_code = ? AND category = ?').run(JSON.stringify(existing), code, category);
    }

    this.cache.delete(this.cacheKey(code, category));
  }

  recordFailure(code: string, category: string, context?: RepairContext): void {
    const row = this.stmtLookup.get(code, category) as Record<string, unknown> | undefined;
    if (!row) return;
    const reward = 0.0;
    const qCount = (row.q_count as number) ?? 0;
    const last5: number[] = row.last_5_rewards ? JSON.parse(row.last_5_rewards as string) : [];
    const alpha = calculateAdaptiveAlpha(qCount, last5);
    const oldQ = row.q_value as number;
    const newQ = oldQ + alpha * (reward - oldQ);
    const newLast5 = [...last5, reward].slice(-5);
    const newVariance = newLast5.length >= 2
      ? newLast5.reduce((s, r) => s + (r - newLast5.reduce((a, b) => a + b, 0) / newLast5.length) ** 2, 0) / (newLast5.length - 1)
      : 0.25;
    this.db.prepare(`UPDATE genes SET q_value = ?, q_variance = ?, q_count = ?, last_5_rewards = ?, last_failed_at = ?, consecutive_failures = consecutive_failures + 1, last_used_at = datetime('now') WHERE failure_code = ? AND category = ?`).run(newQ, newVariance, qCount + 1, JSON.stringify(newLast5), Date.now(), code, category);

    // Store context snapshot
    if (context) {
      const existing = getContextArray(row.failure_context as string);
      existing.push(simplifyContext(context));
      if (existing.length > 10) existing.shift();
      this.db.prepare('UPDATE genes SET failure_context = ? WHERE failure_code = ? AND category = ?').run(JSON.stringify(existing), code, category);
    }

    this.cache.delete(this.cacheKey(code, category));
  }

  list(): GeneCapsule[] { return (this.stmtList.all() as Record<string, unknown>[]).map(parseRow); }
  immuneCount(): number { return (this.stmtCount.get() as { count: number }).count; }
  getSuccessRate(failureCode: string, strategy: string): number { const r = this.db.prepare(`SELECT success_count FROM genes WHERE failure_code = ? AND strategy = ?`).get(failureCode, strategy) as { success_count: number } | undefined; if (!r || r.success_count < 3) return 0.5; return Math.min(0.5 + (r.success_count / 100), 0.95); }

  stats() { const rows = this.stmtList.all() as Record<string, unknown>[]; const allP = new Set<string>(); let qSum = 0; for (const r of rows) { qSum += r.q_value as number; for (const p of JSON.parse(r.platforms as string)) allP.add(p); } return { totalGenes: rows.length, avgQValue: rows.length > 0 ? Math.round((qSum / rows.length) * 100) / 100 : 0, platforms: [...allP], topStrategies: rows.slice(0, 10).map(r => ({ strategy: r.strategy as string, count: r.success_count as number })) }; }

  // ── Seed (D9) ──

  seed(): { seeded: number } {
    const cnt = (this.db.prepare('SELECT COUNT(*) as cnt FROM genes').get() as { cnt: number }).cnt;
    if (cnt > 0) return { seeded: 0 };
    let seeded = 0;
    const ins = this.db.prepare(`INSERT OR IGNORE INTO genes (failure_code, category, strategy, params, success_count, avg_repair_ms, platforms, q_value, consecutive_failures) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.transaction(() => { for (const g of SEED_GENES) { ins.run(g.failureCode, g.category, g.strategy, JSON.stringify(g.params), g.successCount, g.avgRepairMs, JSON.stringify(g.platforms), g.qValue, g.consecutiveFailures); seeded++; } })();
    return { seeded };
  }

  // ── Gene Combine (OPT-3) ──

  combine(): { merged: number } {
    let merged = 0;
    const groups = this.db.prepare(`SELECT failure_code, category, COUNT(*) as cnt FROM genes GROUP BY failure_code, category HAVING cnt > 1`).all() as { failure_code: string; category: string }[];
    for (const g of groups) {
      const genes = this.db.prepare(`SELECT * FROM genes WHERE failure_code = ? AND category = ? ORDER BY q_value DESC`).all(g.failure_code, g.category) as Record<string, unknown>[];
      if (genes.length <= 1) continue;
      const best = genes[0]; const allP = new Set<string>(); let totalSC = 0; let wMs = 0;
      for (const gn of genes) { totalSC += gn.success_count as number; wMs += (gn.avg_repair_ms as number) * (gn.success_count as number); for (const p of JSON.parse(gn.platforms as string)) allP.add(p); }
      const maxQ = Math.max(...genes.map(gn => gn.q_value as number));
      this.db.prepare(`UPDATE genes SET platforms = ?, success_count = ?, avg_repair_ms = ?, q_value = ?, last_used_at = datetime('now') WHERE id = ?`).run(JSON.stringify([...allP]), totalSC, wMs / Math.max(totalSC, 1), maxQ, best.id);
      for (const gn of genes.slice(1)) { this.db.prepare('DELETE FROM genes WHERE id = ?').run(gn.id); merged++; }
    }
    if (merged > 0) this.warmCache();
    return { merged };
  }

  gc(): { merged: number; pruned: number; archived: number } {
    const { merged } = this.combine();
    const pruned = this.db.prepare(`DELETE FROM genes WHERE q_value < 0.1 AND consecutive_failures >= 3`).run().changes;
    const archived = (this.db.prepare(`SELECT COUNT(*) as cnt FROM genes WHERE last_used_at < datetime('now', '-180 days')`).get() as { cnt: number }).cnt;
    if (pruned > 0) this.warmCache();
    return { merged, pruned, archived };
  }

  // ── Reasoning (OPT-4) ──

  recordFailureAnalysis(code: string, category: string, analysis: string): void {
    const row = this.stmtLookup.get(code, category) as Record<string, unknown> | undefined;
    if (!row) return;
    const existing: string[] = row.failure_analysis ? JSON.parse(row.failure_analysis as string) : [];
    const updated = [...existing, `[${new Date().toISOString().slice(0, 10)}] ${analysis}`].slice(-5);
    this.db.prepare(`UPDATE genes SET failure_analysis = ? WHERE failure_code = ? AND category = ?`).run(JSON.stringify(updated), code, category);
    this.cache.delete(this.cacheKey(code, category));
  }

  updateContext(code: string, category: string, success: boolean, context: { chain?: string; walletType?: string; platform?: string }): void {
    const row = this.stmtLookup.get(code, category) as Record<string, unknown> | undefined;
    if (!row) return;
    if (success) {
      const ctx = row.success_context ? JSON.parse(row.success_context as string) : {};
      if (context.chain && !(ctx.chains ?? []).includes(context.chain)) ctx.chains = [...(ctx.chains ?? []), context.chain];
      if (context.platform && !(ctx.platforms ?? []).includes(context.platform)) ctx.platforms = [...(ctx.platforms ?? []), context.platform];
      this.db.prepare('UPDATE genes SET success_context = ? WHERE failure_code = ? AND category = ?').run(JSON.stringify(ctx), code, category);
    } else {
      const ctx = row.failure_context ? JSON.parse(row.failure_context as string) : {};
      if (context.chain && !(ctx.chains ?? []).includes(context.chain)) ctx.chains = [...(ctx.chains ?? []), context.chain];
      this.db.prepare('UPDATE genes SET failure_context = ? WHERE failure_code = ? AND category = ?').run(JSON.stringify(ctx), code, category);
    }
    this.cache.delete(this.cacheKey(code, category));
  }

  // ── Idempotency (D5) ──

  generateRepairId(): string { return `repair_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

  checkRepairInProgress(code: string, category: string): { inProgress: boolean; repairId?: string; txHash?: string } {
    const r = this.db.prepare(`SELECT repair_id, status, tx_hash FROM repair_log WHERE failure_code = ? AND category = ? AND status IN ('pending','completed') AND created_at > datetime('now','-5 minutes') ORDER BY created_at DESC LIMIT 1`).get(code, category) as { repair_id: string; status: string; tx_hash: string } | undefined;
    if (!r) return { inProgress: false };
    if (r.status === 'pending') return { inProgress: true, repairId: r.repair_id };
    if (r.status === 'completed' && r.tx_hash) return { inProgress: true, repairId: r.repair_id, txHash: r.tx_hash };
    return { inProgress: false };
  }

  logRepairStart(id: string, code: string, category: string, strategy: string): void { this.db.prepare(`INSERT OR IGNORE INTO repair_log (repair_id, failure_code, category, strategy, status) VALUES (?,?,?,?,'pending')`).run(id, code, category, strategy); }
  logRepairComplete(id: string, txHash?: string): void { this.db.prepare(`UPDATE repair_log SET status='completed', tx_hash=?, completed_at=datetime('now') WHERE repair_id=?`).run(txHash ?? null, id); }
  logRepairFailed(id: string): void { this.db.prepare(`UPDATE repair_log SET status='failed', completed_at=datetime('now') WHERE repair_id=?`).run(id); }

  // ── Attribution (OPT-10) ──

  recordAttribution(data: { repairId: string; agentId: string; stepId?: string; workflow?: string; failureCode: string; category: string; strategy?: string; success: boolean }): void {
    this.db.prepare(`INSERT INTO repair_attribution (repair_id, agent_id, step_id, workflow, failure_code, category, strategy, success) VALUES (?,?,?,?,?,?,?,?)`).run(data.repairId, data.agentId, data.stepId ?? null, data.workflow ?? null, data.failureCode, data.category, data.strategy ?? null, data.success ? 1 : 0);
  }

  getAgentStats(agentId: string) {
    const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM repair_attribution WHERE agent_id = ?').get(agentId) as { cnt: number }).cnt;
    const cats = this.db.prepare(`SELECT category, COUNT(*) as cnt FROM repair_attribution WHERE agent_id = ? GROUP BY category ORDER BY cnt DESC LIMIT 5`).all(agentId) as { category: string; cnt: number }[];
    const steps = this.db.prepare(`SELECT step_id, COUNT(*) as cnt FROM repair_attribution WHERE agent_id = ? AND step_id IS NOT NULL GROUP BY step_id ORDER BY cnt DESC LIMIT 5`).all(agentId) as { step_id: string; cnt: number }[];
    const ok = (this.db.prepare('SELECT COUNT(*) as cnt FROM repair_attribution WHERE agent_id = ? AND success = 1').get(agentId) as { cnt: number }).cnt;
    return { totalFailures: total, topCategories: cats.map(c => ({ category: c.category, count: c.cnt })), topSteps: steps.map(s => ({ stepId: s.step_id, count: s.cnt })), successRate: total > 0 ? ok / total : 0 };
  }

  getGlobalAttributionStats() {
    const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM repair_attribution').get() as { cnt: number }).cnt;
    const agents = this.db.prepare(`SELECT agent_id, COUNT(*) as cnt FROM repair_attribution GROUP BY agent_id ORDER BY cnt DESC LIMIT 10`).all() as { agent_id: string; cnt: number }[];
    const cats = this.db.prepare(`SELECT category, COUNT(*) as cnt FROM repair_attribution GROUP BY category ORDER BY cnt DESC LIMIT 10`).all() as { category: string; cnt: number }[];
    const ok = (this.db.prepare('SELECT COUNT(*) as cnt FROM repair_attribution WHERE success = 1').get() as { cnt: number }).cnt;
    return { totalRepairs: total, topAgents: agents.map(a => ({ agentId: a.agent_id, failures: a.cnt })), topCategories: cats.map(c => ({ category: c.category, count: c.cnt })), overallSuccessRate: total > 0 ? ok / total : 0 };
  }

  updateReasoning(code: string, category: string, reasoning: string): void {
    this.db.prepare('UPDATE genes SET reasoning = ? WHERE failure_code = ? AND category = ?').run(reasoning, code, category);
    this.cache.delete(this.cacheKey(code, category));
  }

  // ── Gene Links (OPT-5: A-Mem paper) ──

  recordCoOccurrence(codeA: string, catA: string, codeB: string, catB: string): void {
    const [a, b] = [{ code: codeA, cat: catA }, { code: codeB, cat: catB }].sort((x, y) => `${x.code}:${x.cat}`.localeCompare(`${y.code}:${y.cat}`));
    this.db.prepare(`INSERT INTO gene_links (gene_a_code, gene_a_category, gene_b_code, gene_b_category) VALUES (?,?,?,?) ON CONFLICT(gene_a_code, gene_a_category, gene_b_code, gene_b_category) DO UPDATE SET co_occurrence_count = co_occurrence_count + 1, strength = MIN(1.0, strength + 0.1), last_seen_at = datetime('now')`).run(a.code, a.cat, b.code, b.cat);
  }

  getRelatedFailures(code: string, category: string): { code: string; category: string; strength: number; coOccurrences: number }[] {
    return (this.db.prepare(`SELECT CASE WHEN gene_a_code = ? AND gene_a_category = ? THEN gene_b_code ELSE gene_a_code END as rc, CASE WHEN gene_a_code = ? AND gene_a_category = ? THEN gene_b_category ELSE gene_a_category END as rcat, strength, co_occurrence_count as co FROM gene_links WHERE (gene_a_code = ? AND gene_a_category = ?) OR (gene_b_code = ? AND gene_b_category = ?) ORDER BY strength DESC LIMIT 5`).all(code, category, code, category, code, category, code, category) as any[]).map(r => ({ code: r.rc, category: r.rcat, strength: r.strength, coOccurrences: r.co }));
  }

  // ── Health (for CLI) ──

  health(): { totalGenes: number; avgQValue: number; platforms: string[]; topStrategies: { strategy: string; qValue: number; qVariance: number; qCount: number; count: number }[] } {
    const rows = this.stmtList.all() as Record<string, unknown>[];
    const allP = new Set<string>();
    let qSum = 0;
    for (const r of rows) { qSum += r.q_value as number; for (const p of JSON.parse(r.platforms as string)) allP.add(p); }
    return {
      totalGenes: rows.length,
      avgQValue: rows.length > 0 ? qSum / rows.length : 0,
      platforms: [...allP],
      topStrategies: rows.slice(0, 10).map(r => ({ strategy: r.strategy as string, qValue: r.q_value as number, qVariance: (r.q_variance as number) ?? 0.25, qCount: (r.q_count as number) ?? 0, count: r.success_count as number })),
    };
  }

  // ── Audit Log ──

  recordAudit(entry: { agentId: string; errorMessage: string; failureCode: string; failureCategory: string; strategy: string; immune: boolean; success: boolean; verifyPassed?: boolean; mode: string; durationMs: number; qBefore?: number; qAfter?: number; overrides?: Record<string, unknown>; chainSteps?: string[]; predictions?: { code: string; probability: number }[] }): void {
    this.db.prepare(`INSERT INTO repair_audit (timestamp, agent_id, error_message, failure_code, failure_category, strategy, immune, success, verify_passed, mode, duration_ms, q_before, q_after, overrides, chain_steps, predictions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      Date.now(), entry.agentId, entry.errorMessage.slice(0, 500), entry.failureCode, entry.failureCategory, entry.strategy, entry.immune ? 1 : 0, entry.success ? 1 : 0, entry.verifyPassed !== false ? 1 : 0, entry.mode, entry.durationMs, entry.qBefore ?? null, entry.qAfter ?? null, entry.overrides ? JSON.stringify(entry.overrides) : null, entry.chainSteps ? JSON.stringify(entry.chainSteps) : null, entry.predictions ? JSON.stringify(entry.predictions) : null,
    );
  }

  getAuditLog(limit: number = 20): { timestamp: number; agentId: string; failureCode: string; failureCategory: string; strategy: string; immune: boolean; success: boolean; durationMs: number; mode: string }[] {
    return this.db.prepare(`SELECT timestamp, agent_id as agentId, failure_code as failureCode, failure_category as failureCategory, strategy, immune, success, duration_ms as durationMs, mode FROM repair_audit ORDER BY timestamp DESC LIMIT ?`).all(limit).map((row: any) => ({ ...row, immune: !!row.immune, success: !!row.success })) as any[];
  }

  exportAudit(since?: number): string {
    const rows = since
      ? this.db.prepare('SELECT * FROM repair_audit WHERE timestamp >= ? ORDER BY timestamp ASC').all(since)
      : this.db.prepare('SELECT * FROM repair_audit ORDER BY timestamp ASC').all();
    return JSON.stringify(rows, null, 2);
  }

  // ── Failed Repair Records ──

  recordFailedRepair(entry: { failureCode: string; category: string; strategy: string; error: string; repairError: string; context?: Record<string, unknown>; timestamp?: number }): void {
    this.db.prepare(`INSERT INTO failed_repairs (failure_code, category, strategy, error, repair_error, context, timestamp) VALUES (?,?,?,?,?,?,?)`).run(
      entry.failureCode, entry.category, entry.strategy, entry.error.slice(0, 500), entry.repairError.slice(0, 500), JSON.stringify(entry.context ?? {}), entry.timestamp ?? Date.now(),
    );
  }

  getFailedRepairCount(failureCode: string, strategy: string): number {
    return (this.db.prepare('SELECT COUNT(*) as cnt FROM failed_repairs WHERE failure_code = ? AND strategy = ?').get(failureCode, strategy) as { cnt: number }).cnt;
  }

  getFailedRepairs(failureCode: string, strategy: string, limit = 20): import('./failure-distiller.js').FailedRepairRecord[] {
    return this.db.prepare('SELECT failure_code as failureCode, category, strategy, error, repair_error as repairError, context, timestamp FROM failed_repairs WHERE failure_code = ? AND strategy = ? ORDER BY timestamp DESC LIMIT ?').all(failureCode, strategy, limit).map((r: any) => ({ ...r, context: JSON.parse(r.context || '{}') })) as any[];
  }

  /**
   * Recent execution traces for trace-aware LLM Construct fallback.
   * Returns up to `limit` rows: same-failure-code first (most relevant),
   * then same-category fill-in if we don't have enough same-code rows.
   * Each row is enriched with failed_repairs.repair_error via LEFT JOIN
   * when an audit row and a failed_repair row share (code, strategy)
   * within a 5-second window.
   */
  getRecentTraces(failureCode: string, category: string, agentId: string, limit: number = 3): TraceEntry[] {
    // TODO Phase 2: cross-agent local widen — drop the agent_id filter when
    // multi-agent fleet mode is enabled, so an agent can learn from sibling
    // agents on the same machine. See ROADMAP.md procedural-memory phase.
    const SELECT_COLS = `
      ra.timestamp, ra.failure_code, ra.failure_category,
      ra.strategy, ra.success, ra.immune, ra.duration_ms,
      ra.q_before, ra.q_after, ra.error_message,
      fr.repair_error
    `;
    const JOIN_FR = `
      LEFT JOIN failed_repairs fr
        ON fr.failure_code = ra.failure_code
       AND fr.strategy     = ra.strategy
       AND ABS(fr.timestamp - ra.timestamp) < 5000
    `;

    const sameCodeRows = this.db.prepare(`
      SELECT ${SELECT_COLS}
      FROM repair_audit ra
      ${JOIN_FR}
      WHERE ra.failure_code = ? AND ra.agent_id = ?
      ORDER BY ra.timestamp DESC, ra.id DESC
      LIMIT ?
    `).all(failureCode, agentId, limit) as Record<string, unknown>[];

    const toTrace = (r: Record<string, unknown>, tag: 'SAMECODE' | 'CATEGORY'): TraceEntry => ({
      tag,
      timestamp: r.timestamp as number,
      failureCode: r.failure_code as string,
      failureCategory: r.failure_category as string,
      strategy: r.strategy as string,
      success: !!r.success,
      immune: !!r.immune,
      durationMs: (r.duration_ms as number) ?? 0,
      qBefore: (r.q_before as number | null) ?? null,
      qAfter: (r.q_after as number | null) ?? null,
      errorMessage: (r.error_message as string) ?? undefined,
      repairError: (r.repair_error as string) ?? undefined,
    });

    const sameCode = sameCodeRows.map(r => toTrace(r, 'SAMECODE'));
    if (sameCode.length >= limit) return sameCode;

    const fillCount = limit - sameCode.length;
    const categoryRows = this.db.prepare(`
      SELECT ${SELECT_COLS}
      FROM repair_audit ra
      ${JOIN_FR}
      WHERE ra.failure_category = ? AND ra.failure_code != ? AND ra.agent_id = ?
      ORDER BY ra.timestamp DESC, ra.id DESC
      LIMIT ?
    `).all(category, failureCode, agentId, fillCount) as Record<string, unknown>[];

    return [...sameCode, ...categoryRows.map(r => toTrace(r, 'CATEGORY'))];
  }

  // ── Multi-Dimensional Scores ──

  updateScores(code: string, category: string, scores: Record<string, number>): void {
    this.db.prepare('UPDATE genes SET scores = ? WHERE failure_code = ? AND category = ?').run(JSON.stringify(scores), code, category);
    this.cache.delete(this.cacheKey(code, category));
  }

  // ── Predictive Failure Graph (delegated to GenePredictiveGraph) ──

  recordTransition(fromCode: string, fromCategory: string, toCode: string, toCategory: string, delayMs: number): void { this.predict.recordTransition(fromCode, fromCategory, toCode, toCategory, delayMs); }
  predictNext(code: string, category: string, minProbability: number = 0.1) { return this.predict.predictNext(code, category, minProbability); }
  preload(code: ErrorCode, category: FailureCategory): void { this.predict.preload(code, category); }
  getLinks(code: string, category: string) { return this.predict.getLinks(code, category); }

  /** Expose the underlying database for shared tables (e.g. gene_discoveries). */
  get database(): import('better-sqlite3').Database { return this.db; }

  close(): void { this.db.close(); }
}
