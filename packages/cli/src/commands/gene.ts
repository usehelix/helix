import chalk from 'chalk';
import { openGeneMap } from '../pcec/db';

interface CapsuleRow {
  failure_code: string;
  strategy: string;
  q_value: number;
  success_count: number;
  total_uses: number;
  updated_at: string;
}

export async function geneCommand(_options: { list?: boolean }): Promise<void> {
  let capsules: CapsuleRow[] = [];
  try {
    const db = openGeneMap();
    capsules = db.prepare(`
      SELECT failure_code, strategy, q_value, success_count, total_uses, updated_at
      FROM gene_capsules_coding
      ORDER BY q_value DESC
    `).all() as CapsuleRow[];
    db.close();
  } catch (err: any) {
    console.log(chalk.yellow(`Gene Map not initialized: ${err?.message ?? err}`));
    console.log(chalk.dim('Run: vial init'));
    return;
  }

  if (capsules.length === 0) {
    console.log(chalk.dim('\nGene Map is empty.'));
    console.log(chalk.dim('Run some issues with `vial run` to build up capsules.\n'));
    return;
  }

  console.log();
  console.log(chalk.bold(`Gene Map — ${capsules.length} capsules`));
  console.log(chalk.dim('─'.repeat(60)));

  for (const c of capsules) {
    const qColor = c.q_value >= 0.8 ? chalk.green : c.q_value >= 0.5 ? chalk.yellow : chalk.red;
    console.log(
      qColor(`  q=${c.q_value.toFixed(2)}`),
      chalk.white(c.failure_code.padEnd(45)),
      chalk.dim(`${c.success_count}/${c.total_uses} runs`),
    );
  }

  console.log();
}
