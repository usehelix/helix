#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init';
import { triageCommand } from './commands/triage';

const program = new Command();

program
  .name('vial')
  .description('VialOS — Ticket-to-PR for startups')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize VialOS for this repo')
  .option('--repo <owner/repo>', 'GitHub repo (default: auto-detect from git remote)')
  .action(initCommand);

program
  .command('triage')
  .description('Scan open issues and show actionability report')
  .option('--repo <owner/repo>', 'GitHub repo to scan')
  .option('--label <label>', 'Only scan issues with this label')
  .option('--comment', 'Auto-comment on needs-info issues asking for more details')
  .action(triageCommand);

program.parse();
