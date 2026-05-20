import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { GitHubClient, GHIssue } from '../github/client';
import { assessActionability } from '../triage/actionability';
import { generatePlan } from '../execution/planner';
import { executeplan } from '../execution/engine';
import { ghIssueToRef } from '../execution/issue-ref';
import { getConfig } from './init';
import { openGeneMap } from '../pcec/db';

interface RunOptions {
  autoApprove?: boolean;
  dryRun?: boolean;
  repo?: string;
  force?: boolean;
}

export async function runCommand(issueRef: string, options: RunOptions): Promise<void> {
  const config = getConfig();

  const issueNumber = parseInt(issueRef.replace('#', ''), 10);
  if (isNaN(issueNumber)) {
    console.error(chalk.red(`❌ Invalid issue number: ${issueRef}`));
    process.exit(1);
  }

  const [owner, repo] = options.repo
    ? options.repo.split('/')
    : [config.owner, config.repo];

  console.log();
  console.log(chalk.bold('━'.repeat(50)));
  console.log(chalk.bold(`VialOS — Processing Issue #${issueNumber}`));
  console.log(chalk.bold('━'.repeat(50)));
  console.log();

  const client = new GitHubClient(config.githubToken, owner, repo);

  // 1. Read issue
  const spinner = ora('Reading issue...').start();
  let issue: GHIssue;
  try {
    issue = await client.getIssue(issueNumber);
    spinner.succeed(`Issue: "${issue.title}"`);
  } catch {
    spinner.fail(`Could not read issue #${issueNumber}`);
    process.exit(1);
  }

  // 2. Actionability gate
  const actionability = assessActionability(issue!);
  if (actionability.score === 'not_actionable') {
    console.log(chalk.red(`\n🚫 Issue is not actionable: ${actionability.reason}`));
    process.exit(1);
  }
  if (actionability.score === 'needs_info' && !options.force) {
    console.log(chalk.yellow(`\n⚠️  Issue needs more info: ${actionability.reason}`));
    console.log(chalk.dim('   Use --force to run anyway'));
    process.exit(1);
  }
  console.log(chalk.green(`\n✅ Actionable (${Math.round(actionability.confidence * 100)}%)`));

  // 3. Find or clone repo locally
  const repoPath = findOrCloneRepo(owner, repo);

  // 4. Generate execution plan
  const planSpinner = ora('Generating execution plan...').start();
  const ref = ghIssueToRef(issue!);
  const plan = await generatePlan(ref, repoPath);
  planSpinner.succeed('Execution plan ready');

  // Gene Map status — short, non-blocking line
  let geneMapStatus = 'no data yet';
  try {
    const db = openGeneMap();
    const count = (db.prepare('SELECT COUNT(*) as n FROM gene_capsules_coding').get() as { n: number }).n;
    geneMapStatus = count > 0 ? `${count} capsules — querying...` : 'empty, will learn from this run';
    db.close();
  } catch { /* ignore */ }
  console.log(chalk.dim(`  Gene Map: ${geneMapStatus}`));

  // 5. Display plan, wait for approval
  console.log();
  console.log(chalk.bold('📝 Execution Plan'));
  console.log(chalk.dim('─'.repeat(45)));
  const iconMap: Record<string, string> = { read: '📖', analyze: '🔍', implement: '✏️', test: '🧪', pr: '🚀' };
  for (const step of plan.steps) {
    const icon = iconMap[step.type] ?? '▸';
    console.log(`  ${icon} Step ${step.index}: ${chalk.white(step.title)}`);
    console.log(chalk.dim(`       ${step.description}`));
  }
  if (plan.estimatedFiles.length > 0) {
    console.log();
    console.log(chalk.dim(`  Files: ${plan.estimatedFiles.join(', ')}`));
  }
  console.log(chalk.dim(`  Tests: ${plan.testCommand}`));
  console.log(chalk.dim(`  Branch: ${plan.branchName}`));
  console.log();

  if (options.dryRun) {
    console.log(chalk.yellow('Dry run — not executing. Remove --dry-run to proceed.'));
    return;
  }

  if (!options.autoApprove) {
    await waitForApproval();
  }

  // 6. Execute
  console.log();
  console.log(chalk.bold('▶ Starting execution...'));
  console.log();

  const execSpinner = ora('Analyzing codebase + applying fix...').start();
  const result = await executeplan(plan, ref, repoPath, config.githubToken, owner, repo);

  if (!result.success) {
    execSpinner.fail('Execution failed');
    console.log();
    console.log(chalk.red(`Error: ${result.error}`));
    process.exit(1);
  }
  execSpinner.succeed('Done');

  // 7. Report
  console.log();
  console.log(chalk.bold('━'.repeat(50)));
  console.log(chalk.green.bold('✅ Done'));
  console.log();
  console.log(`  PR:     ${chalk.cyan(result.prUrl)}`);
  console.log(`  Files:  ${result.filesChanged.join(', ')}`);
  console.log(`  Tests:  ${result.testsPassed ? chalk.green('passed') : chalk.yellow('not verified')}`);
  console.log(chalk.bold('━'.repeat(50)));
  console.log();
}

// ── Helpers ──

function findOrCloneRepo(owner: string, repo: string): string {
  const home = process.env.HOME || '~';
  const candidates = [
    path.join(process.cwd(), repo),
    path.join(home, 'Projects', repo),
    path.join(home, repo),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, '.git'))) {
      return candidate;
    }
  }
  const clonePath = path.join(home, 'Projects', repo);
  console.log(chalk.dim(`\nCloning ${owner}/${repo}...`));
  execSync(`git clone https://github.com/${owner}/${repo}.git ${clonePath}`, { stdio: 'inherit' });
  return clonePath;
}

async function waitForApproval(): Promise<void> {
  return new Promise((resolve) => {
    let countdown = 30;
    const interval = setInterval(() => {
      const bars = Math.ceil(countdown / 3);
      process.stdout.write(
        `\r${chalk.dim(`[${chalk.yellow('█'.repeat(bars))}${' '.repeat(10 - bars)}] ${countdown}s  Press Enter to approve, Ctrl+C to cancel`)}`
      );
      countdown--;
      if (countdown < 0) {
        clearInterval(interval);
        cleanup();
        console.log(chalk.dim('\n\nAuto-approved.'));
        resolve();
      }
    }, 1000);

    const cleanup = () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.once('data', (key) => {
      clearInterval(interval);
      cleanup();
      if (key.toString() === '') {
        console.log(chalk.red('\n\nCancelled.'));
        process.exit(0);
      }
      console.log(chalk.dim('\n\nApproved.'));
      resolve();
    });
  });
}
