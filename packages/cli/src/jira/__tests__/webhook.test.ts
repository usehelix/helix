import Database from 'better-sqlite3';
import request from 'supertest';
import * as dbModule from '../../pcec/db';
import * as wsModule from '../webhook-server';

// Set encryption key BEFORE importing modules that read it.
process.env.HELIX_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes hex

const fixture = require('./fixtures/issue-created.json');

let testDb: Database.Database;

/** Apply the same schema the production ensureSchema produces. */
function applySchema(db: Database.Database): void {
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
  db.exec(`CREATE TABLE IF NOT EXISTS jira_credentials (
    workspace_id TEXT PRIMARY KEY,
    base_url TEXT NOT NULL,
    email TEXT NOT NULL,
    api_token_encrypted TEXT NOT NULL,
    webhook_secret TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
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
    updated_at TEXT DEFAULT (datetime('now')),
    hint_used_count INTEGER DEFAULT 0,
    hint_ignored_count INTEGER DEFAULT 0
  )`);
}

const MOCK_CTX = {
  ghOwner: 'adrianhihi',
  ghRepo: 'vialos-test-api',
  ghToken: 'gh-test-token',
  ghRepoPath: '/tmp/vialos-test-api',
};

const WEBHOOK_SECRET = 'webhook-test-secret-123';

let mockJiraClient: { getIssue: jest.Mock; addComment: jest.Mock; transitionIssue: jest.Mock };

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);

  // Proxy testDb so production .close() calls don't kill our shared instance.
  const sharedDb = new Proxy(testDb, {
    get(target, prop) {
      if (prop === 'close') return () => { /* no-op for tests */ };
      const v = (target as any)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  jest.spyOn(dbModule, 'openGeneMap').mockReturnValue(sharedDb as any);

  // Inject mock credentials provider — bypasses real DB+decrypt path.
  mockJiraClient = {
    getIssue: jest.fn().mockResolvedValue(fixture.issue),
    addComment: jest.fn().mockResolvedValue(undefined),
    transitionIssue: jest.fn().mockResolvedValue(undefined),
  };
  wsModule._setCredentialsProviderForTesting(() => ({
    client: mockJiraClient as any,
    webhookSecret: WEBHOOK_SECRET,
  }));
});

afterEach(() => {
  jest.restoreAllMocks();
  wsModule._resetCredentialsProviderForTesting();
  wsModule._resetTriageImplForTesting();
  wsModule._resetRunImplForTesting();
  testDb.close();
});

// ── Helpers ──

function insertReceivedRow(): number {
  const r = testDb.prepare(`INSERT INTO jira_webhooks
    (issue_key, project_key, event_type, status, received_at)
    VALUES ('HELIX-101', 'HELIX', 'created', 'received', ?)`)
    .run(Date.now());
  return Number(r.lastInsertRowid);
}

// ── Tests ──

describe('POST /webhooks/jira', () => {
  it('returns 202 + writes received row when secret is correct', async () => {
    // Stub the async work so it doesn't fire real implementations.
    wsModule._setTriageImplForTesting(jest.fn().mockResolvedValue({
      actionable: false, score: 'not_actionable', confidence: 0.5, reason: '',
      perceived: { failure_code: '', category: '', confidence: 0, keywords: [], typical_files: [] },
      qValue: 0, geneMapHit: false,
    }) as any);

    const app = wsModule.buildWebhookApp(MOCK_CTX);
    const res = await request(app)
      .post(`/webhooks/jira?secret=${WEBHOOK_SECRET}`)
      .send(fixture);
    expect(res.status).toBe(202);

    const row = testDb.prepare(`SELECT issue_key, status FROM jira_webhooks ORDER BY id DESC LIMIT 1`).get() as any;
    expect(row.issue_key).toBe('HELIX-101');
    expect(row.status).toBeDefined();
  });

  it('returns 401 when secret is wrong', async () => {
    const app = wsModule.buildWebhookApp(MOCK_CTX);
    const res = await request(app)
      .post(`/webhooks/jira?secret=wrong-secret`)
      .send(fixture);
    expect(res.status).toBe(401);
  });

  it('returns 401 when secret query is missing', async () => {
    const app = wsModule.buildWebhookApp(MOCK_CTX);
    const res = await request(app).post(`/webhooks/jira`).send(fixture);
    expect(res.status).toBe(401);
  });

  it('returns 400 when payload is missing issue.key', async () => {
    const app = wsModule.buildWebhookApp(MOCK_CTX);
    const res = await request(app)
      .post(`/webhooks/jira?secret=${WEBHOOK_SECRET}`)
      .send({ webhookEvent: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('processWebhook', () => {
  it('skips issues without helix-ready label', async () => {
    const noLabel = JSON.parse(JSON.stringify(fixture));
    noLabel.issue.fields.labels = ['bug'];

    const id = insertReceivedRow();
    await wsModule.processWebhook(id, noLabel, MOCK_CTX);

    const row = testDb.prepare(`SELECT status, skip_reason FROM jira_webhooks WHERE id=?`).get(id) as any;
    expect(row.status).toBe('skipped');
    expect(row.skip_reason).toBe('no helix-ready label');
  });

  it('skips when triage returns not actionable', async () => {
    wsModule._setTriageImplForTesting(jest.fn().mockResolvedValue({
      actionable: false, score: 'not_actionable', confidence: 0.85,
      reason: 'architectural decision',
      perceived: { failure_code: 'unknown', category: 'unknown', confidence: 0, keywords: [], typical_files: [] },
      qValue: 0, geneMapHit: false,
    }) as any);

    const id = insertReceivedRow();
    await wsModule.processWebhook(id, fixture, MOCK_CTX);

    const row = testDb.prepare(`SELECT status, skip_reason FROM jira_webhooks WHERE id=?`).get(id) as any;
    expect(row.status).toBe('skipped');
    expect(row.skip_reason).toContain('not actionable');
    expect(mockJiraClient.addComment).toHaveBeenCalledWith(
      'HELIX-101',
      expect.stringContaining('[Helix] Skipped'),
    );
  });

  it('skips when q_value below 0.7 threshold', async () => {
    wsModule._setTriageImplForTesting(jest.fn().mockResolvedValue({
      actionable: true, score: 'actionable', confidence: 0.9, reason: 'ok',
      perceived: { failure_code: 'regex-too-strict', category: 'regex', confidence: 0.8, keywords: ['regex'], typical_files: [] },
      qValue: 0.5, geneMapHit: true,
    }) as any);

    const id = insertReceivedRow();
    await wsModule.processWebhook(id, fixture, MOCK_CTX);

    const row = testDb.prepare(`SELECT status, skip_reason FROM jira_webhooks WHERE id=?`).get(id) as any;
    expect(row.status).toBe('skipped');
    expect(row.skip_reason).toMatch(/q=0\.50/);
  });

  it('runs end-to-end and writes status=done + pr_url on success', async () => {
    wsModule._setTriageImplForTesting(jest.fn().mockResolvedValue({
      actionable: true, score: 'actionable', confidence: 0.9, reason: 'ok',
      perceived: { failure_code: 'regex-too-strict', category: 'regex', confidence: 0.85, keywords: ['regex'], typical_files: [] },
      qValue: 0.85, geneMapHit: true,
    }) as any);
    wsModule._setRunImplForTesting(jest.fn().mockResolvedValue({
      success: true,
      prUrl: 'https://github.com/adrianhihi/vialos-test-api/pull/123',
      prNumber: 123,
      filesChanged: ['src/middleware/validation.ts'],
      testsRun: true,
      testsPassed: true,
      perceived: { failure_code: 'regex-too-strict', category: 'regex', confidence: 0.85, keywords: ['regex'], typical_files: [] },
      geneMapHit: true,
      qValue: 0.85,
    }) as any);

    const id = insertReceivedRow();
    await wsModule.processWebhook(id, fixture, MOCK_CTX);

    const row = testDb.prepare(`SELECT status, pr_url, pr_number, capsule_id FROM jira_webhooks WHERE id=?`).get(id) as any;
    expect(row.status).toBe('done');
    expect(row.pr_url).toBe('https://github.com/adrianhihi/vialos-test-api/pull/123');
    expect(row.pr_number).toBe(123);
    expect(row.capsule_id).toBe('regex-too-strict');

    expect(mockJiraClient.addComment).toHaveBeenCalledWith(
      'HELIX-101',
      expect.stringContaining('PR #123'),
    );
  });

  it('writes status=failed + error when run returns success=false', async () => {
    wsModule._setTriageImplForTesting(jest.fn().mockResolvedValue({
      actionable: true, score: 'actionable', confidence: 0.9, reason: 'ok',
      perceived: { failure_code: 'regex-too-strict', category: 'regex', confidence: 0.85, keywords: ['regex'], typical_files: [] },
      qValue: 0.85, geneMapHit: true,
    }) as any);
    wsModule._setRunImplForTesting(jest.fn().mockResolvedValue({
      success: false,
      error: 'Could not find target code in file',
      filesChanged: [],
      testsRun: false,
      testsPassed: false,
      perceived: { failure_code: 'regex-too-strict', category: 'regex', confidence: 0.85, keywords: ['regex'], typical_files: [] },
      geneMapHit: true,
      qValue: 0.85,
    }) as any);

    const id = insertReceivedRow();
    await wsModule.processWebhook(id, fixture, MOCK_CTX);

    const row = testDb.prepare(`SELECT status, error FROM jira_webhooks WHERE id=?`).get(id) as any;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('Could not find');
    expect(mockJiraClient.addComment).toHaveBeenCalledWith(
      'HELIX-101',
      expect.stringContaining('[Helix] Failed'),
    );
  });

  it('two webhooks for the same issue_key produce two independent rows (no dedup)', async () => {
    wsModule._setTriageImplForTesting(jest.fn().mockResolvedValue({
      actionable: false, score: 'not_actionable', confidence: 0.5, reason: '',
      perceived: { failure_code: '', category: '', confidence: 0, keywords: [], typical_files: [] },
      qValue: 0, geneMapHit: false,
    }) as any);

    const app = wsModule.buildWebhookApp(MOCK_CTX);
    await request(app).post(`/webhooks/jira?secret=${WEBHOOK_SECRET}`).send(fixture);
    await request(app).post(`/webhooks/jira?secret=${WEBHOOK_SECRET}`).send(fixture);

    const rows = testDb.prepare(`SELECT id FROM jira_webhooks WHERE issue_key='HELIX-101'`).all();
    expect(rows.length).toBe(2);
  });
});
