import chalk from 'chalk';
import { HelixError } from './index';

export function displayError(err: unknown, opts: { debug?: boolean } = {}): void {
  console.error('');

  if (err instanceof HelixError) {
    console.error(chalk.red.bold('  ✗ ' + err.message));
    console.error('');

    if (err.remediation.length > 0) {
      console.error(chalk.bold('  What to do:'));
      err.remediation.forEach(line => {
        console.error(chalk.dim('    • ') + line);
      });
      console.error('');
    }

    if (err.docsUrl) {
      console.error(chalk.dim('  Docs: ') + chalk.cyan(err.docsUrl));
      console.error('');
    }

    if (err.retryable) {
      console.error(chalk.dim('  This error is usually transient — try again in a moment.'));
      console.error('');
    }

    if (opts.debug && err.cause) {
      console.error(chalk.dim('  ─── Debug info ───'));
      console.error(chalk.dim(String(err.cause)));
      console.error('');
    } else if (err.cause) {
      console.error(chalk.dim('  Run with VIAL_DEBUG=1 for stack trace.'));
      console.error('');
    }
  } else if (err instanceof Error) {
    console.error(chalk.red.bold('  ✗ Unexpected error: ') + err.message);
    console.error('');
    console.error(chalk.dim('  This might be a Helix bug. Please report:'));
    console.error(chalk.dim('  ') + chalk.cyan('https://github.com/adrianhihi/helix/issues/new'));
    console.error('');
    if (opts.debug) {
      console.error(chalk.dim(err.stack));
    } else {
      console.error(chalk.dim('  Run with VIAL_DEBUG=1 to see the full stack trace.'));
    }
    console.error('');
  } else {
    console.error(chalk.red('  ✗ Unknown error: ') + String(err));
    console.error('');
  }
}
