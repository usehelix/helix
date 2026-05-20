import Database from 'better-sqlite3';
import request from 'supertest';
import * as wsModule from '../webhook-server';
import type { WebhookDeps, WebhookContext } from '../webhook-server';

process.env.HELIX_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes hex

const fixture = require('./fixtures/issue-created.json');

let testDb: Database.Database;

function applySchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS jira_webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_key TEXT NOT NULL, project_key TEXT NOT NULL, event_type TEXT NOT NULL,
    status TEXT NOT NULL, skip_reason TEXT,
    received_at INTEGER NOT NULL, processed_at INTEGER,
    capsule_id TEXT, pr_url TEXT, pr_number INTEGER, error TEXT
  )`);
}

const MOCK_CTX: WebhookContext = {
  ghOwner: 'adrianhihi',
  ghRepo: 'vialos-test-api',
  ghToken: 'gh-test-token',
  ghRepoPath: '/tmp/vialos-test-api',
};

const WEBHOOK_SECRET = 'webhook-test-secret-123';

let mockJiraClient: { getIssue: jest.Mock; addComment: jest.Mock; transitionIssue: jest.Mock };
let deps: WebhookDeps;

/** Build a deps object that wires mocks for triage/run/credentials and reuses testDb. */
function buildMockDeps(opts: {
  triage?: jest.Mock;
  run?: jest.Mock;
} = {}): WebhookDeps {
  mockJiraClient = {
    getIssue: jest.fn().mockResolvedValue(fixture.issue),
    addComment: jest.fn().mockResolvedValue(undefined),
    transitionIssue: jest.fn().mockResolvedValue(undefined),
  };
  return {
    credentialsProvider: () => ({ client: mockJiraClient as any, webhookSecret: WEBHOOK_SECRET }),
    triage: (opts.triage ?? jest.fn().mockResolvedValue({
      actionable: false, score: 'not_actionable', confidence: 0.5, reason: '',
      perceived: { failure_code: '', category: '', confidence: 0, keywords: [], typical_files: [] },
      qValue: 0, geneMapHit: false,
    })) as any,
    run: (opts.run ?? jest.fn().mockResolvedValue({} as any)) as any,
    // Proxy close-as-noop so the shared testDb isn't killed mid-test.
    openDb: () => new Proxy(testDb, {
      get(target, prop) {
        if (prop === 'close') return () => { /* no-op */ };
        const v = (target as any)[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as any,
  };
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  deps = buildMockDeps();
});

afterEach(() => {
  testDb.close();
});

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
    const app = wsModule.buildWebhookApp(MOCK_CTX, deps);
    const res = await request(app)
      .post(`/webhooks/jira?secret=${WEBHOOK_SECRET}`)
      .send(fixture);
    expect(res.status).toBe(202);

    const row = testDb.prepare(`SELECT issue_key, status FROM jira_webhooks ORDER BY id DESC LIMIT 1`).get() as any;
    expect(row.issue_key).toBe('HELIX-101');
    expect(row.status).toBeDefined();
  });

  it('returns 401 when secret is wrong', async () => {
    const app = wsModule.buildWebhookApp(MOCK_CTX, deps);
    const res = await request(app)
      .post(`/webhooks/jira?secret=wrong-secret`)
      .send(fixture);
    expect(res.status).toBe(401);
  });

  it('returns 401 when secret query is missing', async () => {
    const app = wsModule.buildWebhookApp(MOCK_CTX, deps);
    const res = await request(app).post(`/webhooks/jira`).send(fixture);
    expect(res.status).toBe(401);
  });

  it('returns 400 when payload is missing issue.key', async () => {
    const app = wsModule.buildWebhookApp(MOCK_CTX, deps);
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
    await wsModule.processWebhook(id, noLabel, MOCK_CTX, deps);

    const row = testDb.prepare(`SELECT status, skip_reason FROM jira_webhooks WHERE id=?`).get(id) as any;
    expect(row.status).toBe('skipped');
    expect(row.skip_reason).toBe('no helix-ready label');
  });

  it('skips when triage returns not actionable', async () => {
    deps = buildMockDeps({
      triage: jest.fn().mockResolvedValue({
        actionable: false, score: 'not_actionable', confidence: 0.85,
        reason: 'architectural decision',
        perceived: { failure_code: 'unknown', category: 'unknown', confidence: 0, keywords: [], typical_files: [] },
        qValue: 0, geneMapHit: false,
      }),
    });

    const id = insertReceivedRow();
    await wsModule.processWebhook(id, fixture, MOCK_CTX, deps);

    const row = testDb.prepare(`SELECT status, skip_reason FROM jira_webhooks WHERE id=?`).get(id) as any;
    expect(row.status).toBe('skipped');
    expect(row.skip_reason).toContain('not actionable');
    expect(mockJiraClient.addComment).toHaveBeenCalledWith(
      'HELIX-101',
      expect.stringContaining('[Helix] Skipped'),
    );
  });

  it('skips when q_value below 0.7 threshold', async () => {
    deps = buildMockDeps({
      triage: jest.fn().mockResolvedValue({
        actionable: true, score: 'actionable', confidence: 0.9, reason: 'ok',
        perceived: { failure_code: 'regex-too-strict', category: 'regex', confidence: 0.8, keywords: ['regex'], typical_files: [] },
        qValue: 0.5, geneMapHit: true,
      }),
    });

    const id = insertReceivedRow();
    await wsModule.processWebhook(id, fixture, MOCK_CTX, deps);

    const row = testDb.prepare(`SELECT status, skip_reason FROM jira_webhooks WHERE id=?`).get(id) as any;
    expect(row.status).toBe('skipped');
    expect(row.skip_reason).toMatch(/q=0\.50/);
  });

  it('runs end-to-end and writes status=done + pr_url on success', async () => {
    deps = buildMockDeps({
      triage: jest.fn().mockResolvedValue({
        actionable: true, score: 'actionable', confidence: 0.9, reason: 'ok',
        perceived: { failure_code: 'regex-too-strict', category: 'regex', confidence: 0.85, keywords: ['regex'], typical_files: [] },
        qValue: 0.85, geneMapHit: true,
      }),
      run: jest.fn().mockResolvedValue({
        success: true,
        prUrl: 'https://github.com/adrianhihi/vialos-test-api/pull/123',
        prNumber: 123,
        filesChanged: ['src/middleware/validation.ts'],
        testsRun: true,
        testsPassed: true,
        perceived: { failure_code: 'regex-too-strict', category: 'regex', confidence: 0.85, keywords: ['regex'], typical_files: [] },
        geneMapHit: true,
        qValue: 0.85,
      }),
    });

    const id = insertReceivedRow();
    await wsModule.processWebhook(id, fixture, MOCK_CTX, deps);

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
    deps = buildMockDeps({
      triage: jest.fn().mockResolvedValue({
        actionable: true, score: 'actionable', confidence: 0.9, reason: 'ok',
        perceived: { failure_code: 'regex-too-strict', category: 'regex', confidence: 0.85, keywords: ['regex'], typical_files: [] },
        qValue: 0.85, geneMapHit: true,
      }),
      run: jest.fn().mockResolvedValue({
        success: false,
        error: 'Could not find target code in file',
        filesChanged: [],
        testsRun: false,
        testsPassed: false,
        perceived: { failure_code: 'regex-too-strict', category: 'regex', confidence: 0.85, keywords: ['regex'], typical_files: [] },
        geneMapHit: true,
        qValue: 0.85,
      }),
    });

    const id = insertReceivedRow();
    await wsModule.processWebhook(id, fixture, MOCK_CTX, deps);

    const row = testDb.prepare(`SELECT status, error FROM jira_webhooks WHERE id=?`).get(id) as any;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('Could not find');
    expect(mockJiraClient.addComment).toHaveBeenCalledWith(
      'HELIX-101',
      expect.stringContaining('[Helix] Failed'),
    );
  });

  it('two webhooks for the same issue_key produce two independent rows (no dedup)', async () => {
    const app = wsModule.buildWebhookApp(MOCK_CTX, deps);
    await request(app).post(`/webhooks/jira?secret=${WEBHOOK_SECRET}`).send(fixture);
    await request(app).post(`/webhooks/jira?secret=${WEBHOOK_SECRET}`).send(fixture);

    const rows = testDb.prepare(`SELECT id FROM jira_webhooks WHERE issue_key='HELIX-101'`).all();
    expect(rows.length).toBe(2);
  });
});
