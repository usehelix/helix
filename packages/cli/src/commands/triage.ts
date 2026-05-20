import chalk from 'chalk';
import ora from 'ora';
import { GitHubClient } from '../github/client';
import { assessActionability, ActionabilityResult } from '../triage/actionability';
import { getConfig } from './init';
import { loadJiraClient } from '../jira/webhook-server';
import { jiraIssueToTriageInput } from '../jira/perceive-adapter';
import { triageProgrammatic } from '../programmatic';

interface TriageResult {
  number: number;
  title: string;
  url: string;
  result: ActionabilityResult;
}

export async function triageCommand(options: {
  label?: string;
  comment?: boolean;
  repo?: string;
  source?: string;       // 'jira' for Jira-sourced triage of a single ticket
  jiraKey?: string;      // Jira issue key when --source jira (positional via flag)
}): Promise<void> {
  // ── Jira mode: triage a single Jira ticket (no listOpenIssues) ──
  if (options.source === 'jira') {
    if (!options.jiraKey) {
      console.error(chalk.red('Pass the Jira issue key via --jira-key <KEY> (e.g. --jira-key HELIX-123)'));
      process.exit(1);
    }
    const { client } = loadJiraClient();
    const issue = await client.getIssue(options.jiraKey);
    const input = jiraIssueToTriageInput(issue);
    const r = await triageProgrammatic(input);
    console.log();
    console.log(chalk.bold(`Jira ${options.jiraKey}: ${input.title}`));
    console.log(chalk.dim('─'.repeat(55)));
    const scoreColor = r.score === 'actionable' ? chalk.green : r.score === 'needs_info' ? chalk.yellow : chalk.red;
    console.log(scoreColor(`  ${r.score}`), chalk.dim(`confidence=${Math.round(r.confidence * 100)}%`));
    console.log(chalk.dim(`  perceived: ${r.perceived.failure_code} (${Math.round(r.perceived.confidence * 100)}%)`));
    console.log(chalk.dim(`  Gene Map:  ${r.geneMapHit ? `HIT q=${r.qValue.toFixed(2)}` : 'miss'}`));
    console.log(chalk.dim(`  reason:    ${r.reason}`));
    console.log();
    return;
  }

  // ── Default: GitHub mode (existing behavior) ──
  const config = getConfig();
  const [owner, repo] = options.repo
    ? options.repo.split('/')
    : [config.owner, config.repo];

  const client = new GitHubClient(config.githubToken, owner, repo);

  const spinner = ora(`Scanning ${owner}/${repo}...`).start();

  let issues = await client.listOpenIssues();

  if (options.label) {
    issues = issues.filter(i =>
      i.labels.some(l => l.name === options.label)
    );
  }

  spinner.stop();

  if (issues.length === 0) {
    console.log(chalk.yellow('\nNo open issues found.'));
    return;
  }

  const results: TriageResult[] = issues.map(issue => ({
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    result: assessActionability(issue),
  }));

  const actionable = results.filter(r => r.result.score === 'actionable');
  const needsInfo = results.filter(r => r.result.score === 'needs_info');
  const notActionable = results.filter(r => r.result.score === 'not_actionable');

  console.log();
  console.log(chalk.bold(`VialOS Triage — ${owner}/${repo}`));
  console.log(chalk.dim(`${issues.length} open issues scanned`));
  console.log(chalk.dim('─'.repeat(55)));

  if (actionable.length > 0) {
    console.log();
    console.log(chalk.green.bold(`✅ ACTIONABLE (${actionable.length} issues)`));
    for (const r of actionable) {
      const confidence = Math.round(r.result.confidence * 100);
      console.log(
        chalk.green(`  #${String(r.number).padEnd(4)}`),
        chalk.white(truncate(r.title, 48)),
        chalk.dim(`[${confidence}%]`)
      );
    }
  }

  if (needsInfo.length > 0) {
    console.log();
    console.log(chalk.yellow.bold(`⚠️  NEEDS INFO (${needsInfo.length} issues)`));
    for (const r of needsInfo) {
      console.log(
        chalk.yellow(`  #${String(r.number).padEnd(4)}`),
        chalk.white(truncate(r.title, 40)),
        chalk.dim(`→ needs: ${r.result.missing.map(m => m.field.replace('_', ' ')).join(', ')}`)
      );
    }
  }

  if (notActionable.length > 0) {
    console.log();
    console.log(chalk.red.bold(`🚫 NOT ACTIONABLE (${notActionable.length} issues)`));
    for (const r of notActionable) {
      console.log(
        chalk.red(`  #${String(r.number).padEnd(4)}`),
        chalk.white(truncate(r.title, 40)),
        chalk.dim(`→ ${r.result.reason.split(' ').slice(0, 6).join(' ')}...`)
      );
    }
  }

  console.log();
  console.log(chalk.dim('─'.repeat(55)));

  if (actionable.length > 0) {
    console.log(
      chalk.dim(`Run ${chalk.white(`vial run #${actionable[0].number}`)} to start,`),
      chalk.dim(`or ${chalk.white('vial run --next')} for highest priority.`)
    );
  }

  if (options.comment && needsInfo.length > 0) {
    console.log();
    const commentSpinner = ora('Adding comments to needs-info issues...').start();
    for (const r of needsInfo) {
      if (r.result.suggestedComment) {
        await client.addComment(r.number, r.result.suggestedComment);
      }
    }
    commentSpinner.succeed(`Added comments to ${needsInfo.length} issues`);
  }

  console.log();
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max - 1) + '…' : str;
}
