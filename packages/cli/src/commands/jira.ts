import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import { openGeneMap } from '../pcec/db';
import { encrypt, generateWebhookSecret } from '../jira/encryption';
import { loadJiraClient, processWebhook, startWebhookServer, WebhookContext, WebhookDeps } from '../jira/webhook-server';
import { triageProgrammatic, runProgrammatic } from '../programmatic';
import { getConfig } from './init';

interface ConnectOpts {
  baseUrl: string;
  email: string;
  token: string;
  workspaceId?: string;
}

async function jiraConnect(opts: ConnectOpts): Promise<void> {
  if (!opts.baseUrl || !opts.email || !opts.token) {
    console.error(chalk.red('Missing --base-url / --email / --token'));
    process.exit(1);
  }

  // Encrypt the api_token. Throws if HELIX_ENCRYPTION_KEY isn't set/invalid.
  let encryptedToken: string;
  try {
    encryptedToken = encrypt(opts.token);
  } catch (err: any) {
    console.error(chalk.red(`Encryption failed: ${err?.message ?? err}`));
    console.error(chalk.dim('Generate a key with: node -e "console.log(require(\\"crypto\\").randomBytes(32).toString(\\"hex\\"))"'));
    process.exit(1);
  }

  const webhookSecret = generateWebhookSecret();
  const workspaceId = opts.workspaceId || 'default';

  const db = openGeneMap();
  db.prepare(`
    INSERT INTO jira_credentials (workspace_id, base_url, email, api_token_encrypted, webhook_secret, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      base_url = excluded.base_url,
      email = excluded.email,
      api_token_encrypted = excluded.api_token_encrypted,
      webhook_secret = excluded.webhook_secret,
      created_at = excluded.created_at
  `).run(workspaceId, opts.baseUrl, opts.email, encryptedToken, webhookSecret, Date.now());
  db.close();

  console.log(chalk.green(`\n✅ Jira credentials saved for workspace "${workspaceId}".\n`));
  console.log(chalk.bold('Webhook URL to configure in Jira:'));
  console.log(`  https://<your-host>/webhooks/jira?secret=${webhookSecret}\n`);
  console.log(chalk.dim('Keep this secret out of logs. To rotate, re-run `vial jira connect`.\n'));
}

function buildWebhookContext(): WebhookContext {
  const cfg = getConfig();
  const repoPath = findRepoPath(cfg.owner, cfg.repo);
  return {
    ghOwner: cfg.owner,
    ghRepo: cfg.repo,
    ghToken: cfg.githubToken,
    ghRepoPath: repoPath,
  };
}

function findRepoPath(owner: string, repo: string): string {
  const home = process.env.HOME || '~';
  const candidates = [
    path.join(process.cwd(), repo),
    path.join(home, 'Projects', repo),
    path.join(home, repo),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, '.git'))) return c;
  }
  throw new Error(`Local clone of ${owner}/${repo} not found. Run vial init or clone the repo first.`);
}

async function jiraWebhookStart(opts: { port?: string }): Promise<void> {
  const port = parseInt(opts.port || '7430', 10);
  if (Number.isNaN(port)) {
    console.error(chalk.red(`Invalid --port: ${opts.port}`));
    process.exit(1);
  }
  // Quick sanity: credentials present + GH repo configured
  try {
    loadJiraClient();
  } catch (err: any) {
    console.error(chalk.red(err?.message ?? err));
    process.exit(1);
  }
  let ctx: WebhookContext;
  try {
    ctx = buildWebhookContext();
  } catch (err: any) {
    console.error(chalk.red(err?.message ?? err));
    process.exit(1);
  }
  startWebhookServer(port, ctx);
}

async function jiraSync(issueKey: string): Promise<void> {
  if (!issueKey) {
    console.error(chalk.red('Missing issue key (e.g. HELIX-123)'));
    process.exit(1);
  }
  const ctx = buildWebhookContext();
  const { client } = loadJiraClient();
  const issue = await client.getIssue(issueKey);

  // Insert a synthetic webhook row so processWebhook can track it.
  const db = openGeneMap();
  const result = db.prepare(`
    INSERT INTO jira_webhooks (issue_key, project_key, event_type, status, received_at)
    VALUES (?, ?, 'manual_sync', 'received', ?)
  `).run(issueKey, issue.fields.project.key, Date.now());
  const webhookId = Number(result.lastInsertRowid);
  db.close();

  console.log(chalk.dim(`Sync started — webhookId=${webhookId}`));
  const deps: WebhookDeps = {
    credentialsProvider: loadJiraClient,
    triage: triageProgrammatic,
    run: runProgrammatic,
    openDb: openGeneMap,
  };
  await processWebhook(webhookId, { issue, webhookEvent: 'manual_sync' }, ctx, deps);
  console.log(chalk.green(`✅ Sync complete. Check DB: SELECT * FROM jira_webhooks WHERE id=${webhookId}`));
}

/**
 * Register `vial jira <subcommand>` on the commander program.
 */
export function registerJiraCommand(program: Command): void {
  const jira = program.command('jira').description('Jira integration commands');

  jira.command('connect')
    .description('Store Jira credentials (encrypted) and generate a webhook secret')
    .requiredOption('--base-url <url>', 'Jira base URL, e.g. https://acme.atlassian.net')
    .requiredOption('--email <email>', 'Jira account email')
    .requiredOption('--token <token>', 'Atlassian API token')
    .option('--workspace-id <id>', 'Workspace identifier', 'default')
    .action(jiraConnect);

  jira.command('webhook')
    .description('Webhook subcommands')
    .command('start')
    .description('Start the webhook HTTP listener (foreground)')
    .option('--port <port>', 'Listen port', '7430')
    .action(jiraWebhookStart);

  jira.command('sync <issueKey>')
    .description('Manually process a Jira issue end-to-end (skip the webhook listener)')
    .action(jiraSync);
}
