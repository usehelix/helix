#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init';
import { triageCommand } from './commands/triage';
import { runCommand } from './commands/run';
import { geneCommand } from './commands/gene';
import { registerJiraCommand } from './commands/jira';
import { displayError } from './errors/display';

const program = new Command();

program
  .name('vial')
  .description('VialOS — Ticket-to-PR for startups')
  .version('0.1.0');

/**
 * Wrap any commander action with the unified error handler so unhandled HelixErrors
 * are formatted (remediation + retryable hint) and unknown errors point to issue tracker.
 * VIAL_DEBUG=1 enables stack traces.
 */
function wrapAction<T extends unknown[]>(fn: (...args: T) => Promise<void> | void): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (err) {
      displayError(err, { debug: process.env.VIAL_DEBUG === '1' });
      process.exit(1);
    }
  };
}

program
  .command('init')
  .description('Initialize VialOS for this repo')
  .option('--repo <owner/repo>', 'GitHub repo (default: auto-detect from git remote)')
  .action(wrapAction(initCommand));

program
  .command('triage')
  .description('Scan open issues and show actionability report')
  .option('--repo <owner/repo>', 'GitHub repo to scan')
  .option('--label <label>', 'Only scan issues with this label')
  .option('--comment', 'Auto-comment on needs-info issues asking for more details')
  .option('--source <source>', 'Source to triage from: "github" (default) or "jira"')
  .option('--jira-key <key>', 'Jira issue key when --source jira (e.g. HELIX-123)')
  .action(wrapAction(triageCommand));

program
  .command('run <issue>')
  .description('Process an issue: analyze → fix → test → open PR')
  .option('--auto-approve', 'Skip the 30s planning confirmation')
  .option('--dry-run', 'Generate plan only, do not execute')
  .option('--force', 'Run even on needs_info issues')
  .option('--skip-tests', 'Push the fix without running tests first')
  .option('--repo <owner/repo>', 'GitHub repo to use')
  .action(wrapAction(runCommand));

program
  .command('gene')
  .description('View Gene Map capsules')
  .option('--list', 'List all capsules')
  .action(wrapAction(geneCommand));

registerJiraCommand(program);

program.parse();
