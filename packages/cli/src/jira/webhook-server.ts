import express, { Request, Response, Application } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { JiraClient, JiraCredentials } from './client';
import { jiraIssueToTriageInput, TriageInput } from './perceive-adapter';
import { triageProgrammatic, runProgrammatic } from '../programmatic';
import { openGeneMap } from '../pcec/db';
import { decrypt } from './encryption';

interface StoredCreds {
  base_url: string;
  email: string;
  api_token_encrypted: string;
  webhook_secret: string;
}

/**
 * Load Jira credentials + decrypt the api_token from the local DB.
 * Used by the production factory; tests pass a mock provider via WebhookDeps.
 */
export function loadJiraClient(workspaceId = 'default'): { client: JiraClient; webhookSecret: string } {
  const db = openGeneMap();
  try {
    const row = db.prepare(`
      SELECT base_url, email, api_token_encrypted, webhook_secret
      FROM jira_credentials WHERE workspace_id = ?
    `).get(workspaceId) as StoredCreds | undefined;
    if (!row) {
      throw new Error(`No Jira credentials for workspace "${workspaceId}". Run: vial jira connect`);
    }
    const creds: JiraCredentials = {
      baseUrl: row.base_url,
      email: row.email,
      apiToken: decrypt(row.api_token_encrypted),
    };
    return { client: new JiraClient(creds), webhookSecret: row.webhook_secret };
  } finally {
    db.close();
  }
}

function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface WebhookContext {
  ghOwner: string;
  ghRepo: string;
  ghToken: string;
  ghRepoPath: string;
}

/**
 * Explicit dependency surface for the webhook handler.
 * Production wires real implementations; tests construct mocks per-test.
 */
export interface WebhookDeps {
  credentialsProvider: (workspaceId?: string) => { client: JiraClient; webhookSecret: string };
  triage: typeof triageProgrammatic;
  run: typeof runProgrammatic;
  openDb: () => Database.Database;
}

/**
 * Production factory — wires in real DB + real triage/run pipelines.
 */
export function buildProductionWebhookApp(ctx: WebhookContext): Application {
  return buildWebhookApp(ctx, {
    credentialsProvider: loadJiraClient,
    triage: triageProgrammatic,
    run: runProgrammatic,
    openDb: openGeneMap,
  });
}

export function buildWebhookApp(ctx: WebhookContext, deps: WebhookDeps): Application {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/webhooks/jira', async (req: Request, res: Response): Promise<void> => {
    let expectedSecret: string;
    try {
      ({ webhookSecret: expectedSecret } = deps.credentialsProvider());
    } catch (err: any) {
      res.status(500).json({ error: `Jira not configured: ${err?.message ?? err}` });
      return;
    }
    if (!secretsMatch(req.query.secret as string | undefined, expectedSecret)) {
      res.status(401).json({ error: 'invalid secret' });
      return;
    }

    const payload = req.body;
    const issueKey = payload?.issue?.key as string | undefined;
    const projectKey = payload?.issue?.fields?.project?.key as string | undefined;
    const eventType = (payload?.webhookEvent ?? payload?.issue_event_type_name ?? 'unknown') as string;

    if (!issueKey || !projectKey) {
      res.status(400).json({ error: 'missing issue.key or project.key in payload' });
      return;
    }

    const db = deps.openDb();
    const result = db.prepare(`
      INSERT INTO jira_webhooks (issue_key, project_key, event_type, status, received_at)
      VALUES (?, ?, ?, 'received', ?)
    `).run(issueKey, projectKey, eventType, Date.now());
    const webhookId = Number(result.lastInsertRowid);
    db.close();

    res.status(202).json({ webhookId });

    setImmediate(() => {
      processWebhook(webhookId, payload, ctx, deps).catch(err => {
        console.error(`[Helix] webhook ${webhookId} processing failed:`, err);
      });
    });
  });

  return app;
}

/**
 * Process a Jira webhook event end-to-end. Exported so `vial jira sync` can reuse.
 * Takes deps explicitly so tests can substitute without globals.
 */
export async function processWebhook(
  webhookId: number,
  payload: any,
  ctx: WebhookContext,
  deps: WebhookDeps,
): Promise<void> {
  const db = deps.openDb();
  const issue = payload.issue;
  const issueKey: string = issue.key;
  const labels: string[] = issue.fields?.labels ?? [];

  if (!labels.includes('helix-ready')) {
    db.prepare(`UPDATE jira_webhooks SET status='skipped', skip_reason=?, processed_at=? WHERE id=?`)
      .run('no helix-ready label', Date.now(), webhookId);
    db.close();
    return;
  }

  db.prepare(`UPDATE jira_webhooks SET status='processing' WHERE id=?`).run(webhookId);
  db.close();

  let client: JiraClient;
  try {
    ({ client } = deps.credentialsProvider());
  } catch (err: any) {
    const db2 = deps.openDb();
    db2.prepare(`UPDATE jira_webhooks SET status='failed', error=?, processed_at=? WHERE id=?`)
      .run(`load credentials: ${err?.message ?? err}`, Date.now(), webhookId);
    db2.close();
    return;
  }

  try {
    const full = await client.getIssue(issueKey);
    const triageInput: TriageInput = jiraIssueToTriageInput(full);

    const t = await deps.triage(triageInput);

    if (!t.actionable || t.qValue < 0.7) {
      const reason = !t.actionable
        ? `not actionable (${t.score}: ${t.reason})`
        : `q=${t.qValue.toFixed(2)} < 0.7 (need confident capsule before auto-fix)`;
      await client.addComment(issueKey, `[Helix] Skipped: ${reason}`);
      const db2 = deps.openDb();
      db2.prepare(`UPDATE jira_webhooks SET status='skipped', skip_reason=?, processed_at=? WHERE id=?`)
        .run(reason, Date.now(), webhookId);
      db2.close();
      return;
    }

    const r = await deps.run({
      input: triageInput,
      owner: ctx.ghOwner,
      repo: ctx.ghRepo,
      githubToken: ctx.ghToken,
      repoPath: ctx.ghRepoPath,
    });

    if (!r.success) {
      await client.addComment(issueKey, `[Helix] Failed: ${r.error ?? 'unknown error'}`);
      const db2 = deps.openDb();
      db2.prepare(`UPDATE jira_webhooks SET status='failed', error=?, processed_at=? WHERE id=?`)
        .run(r.error ?? 'unknown', Date.now(), webhookId);
      db2.close();
      return;
    }

    await client.addComment(
      issueKey,
      `[Helix] PR #${r.prNumber} opened: ${r.prUrl}\n` +
      `failure_code: ${r.perceived.failure_code}\n` +
      `Gene Map: ${r.geneMapHit ? 'HIT' : 'MISS'} (q=${r.qValue.toFixed(2)})`
    );

    const db3 = deps.openDb();
    db3.prepare(`
      UPDATE jira_webhooks
      SET status='done', capsule_id=?, pr_url=?, pr_number=?, processed_at=?
      WHERE id=?
    `).run(r.perceived.failure_code, r.prUrl ?? null, r.prNumber ?? null, Date.now(), webhookId);
    db3.close();
  } catch (err: any) {
    const db2 = deps.openDb();
    db2.prepare(`UPDATE jira_webhooks SET status='failed', error=?, processed_at=? WHERE id=?`)
      .run(err?.message ?? String(err), Date.now(), webhookId);
    db2.close();
    try {
      await client.addComment(issueKey, `[Helix] Failed: ${err?.message ?? err}`);
    } catch { /* nested addComment failure is non-fatal */ }
  }
}

export function startWebhookServer(port: number, ctx: WebhookContext): void {
  const app = buildProductionWebhookApp(ctx);
  app.listen(port, () => {
    console.log(`[Helix] Jira webhook listener on :${port}`);
    console.log(`        POST http://localhost:${port}/webhooks/jira?secret=<your-secret>`);
  });
}
