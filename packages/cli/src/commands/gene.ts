import chalk from 'chalk';
import { openGeneMap } from '../pcec/db';

interface CapsuleRow {
  failure_code: string;
  strategy: string;
  q_value: number;
  success_count: number;
  total_uses: number;
  updated_at: string;
  hint_used_count: number;
  hint_ignored_count: number;
}

export async function geneCommand(_options: { list?: boolean }): Promise<void> {
  let capsules: CapsuleRow[] = [];
  try {
    const db = openGeneMap();
    capsules = db.prepare(`
      SELECT failure_code, strategy, q_value, success_count, total_uses, updated_at,
             COALESCE(hint_used_count, 0) AS hint_used_count,
             COALESCE(hint_ignored_count, 0) AS hint_ignored_count
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
  console.log(chalk.dim('─'.repeat(72)));

  for (const c of capsules) {
    const qColor = c.q_value >= 0.8 ? chalk.green : c.q_value >= 0.5 ? chalk.yellow : chalk.red;
    const hintTotal = c.hint_used_count + c.hint_ignored_count;
    const hintRate = hintTotal > 0 ? Math.round((c.hint_used_count / hintTotal) * 100) : null;
    const hintCol = hintRate !== null ? `hint:${hintRate}%` : 'hint:n/a';

    console.log(
      qColor(`  q=${c.q_value.toFixed(2)}`),
      chalk.white(c.failure_code.padEnd(42)),
      chalk.dim(`${c.success_count}/${c.total_uses} runs`.padEnd(12)),
      chalk.dim(hintCol),
    );
  }

  console.log();
}
