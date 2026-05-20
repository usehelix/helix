import type Database from 'better-sqlite3';
import { PerceiveResult } from './perceive';

export interface CommitInput {
  perceiveResult: PerceiveResult;
  strategy: string;
  filesChanged: string[];
  prUrl: string;
  success: boolean;
  repoName: string;
  issueNumber: number;
}

export function commit(db: Database.Database, input: CommitInput): void {
  if (!input.success) {
    // Failed fix: decrement q_value if a capsule for this failure_code already exists.
    const existing = db.prepare(`
      SELECT id, q_value FROM gene_capsules_coding WHERE failure_code = ?
    `).get(input.perceiveResult.failure_code) as { id: number; q_value: number } | undefined;

    if (existing) {
      const newQ = Math.max(0.1, existing.q_value - 0.1);
      db.prepare(`
        UPDATE gene_capsules_coding
        SET q_value = ?,
            failure_count = failure_count + 1,
            updated_at = datetime('now')
        WHERE failure_code = ?
      `).run(newQ, input.perceiveResult.failure_code);
    }
    return;
  }

  // Successful fix: upsert capsule.
  const existing = db.prepare(`
    SELECT id, q_value, success_count, typical_files
    FROM gene_capsules_coding
    WHERE failure_code = ?
  `).get(input.perceiveResult.failure_code) as { id: number; q_value: number; success_count: number; typical_files: string | null } | undefined;

  if (existing) {
    // Update: nudge q_value toward 1.0 with exponential decay (15% step).
    const newQ = Math.min(0.98, existing.q_value + (1 - existing.q_value) * 0.15);
    const newFiles = mergeFiles(
      JSON.parse(existing.typical_files || '[]') as string[],
      input.filesChanged,
    );

    db.prepare(`
      UPDATE gene_capsules_coding
      SET q_value = ?,
          success_count = success_count + 1,
          typical_files = ?,
          source_repo = ?,
          updated_at = datetime('now')
      WHERE failure_code = ?
    `).run(
      newQ,
      JSON.stringify(newFiles),
      input.repoName,
      input.perceiveResult.failure_code,
    );
  } else {
    // Create new capsule with initial q_value=0.7 (first successful fix).
    const hint = buildHintFromStrategy(input.strategy, input.perceiveResult.failure_code);

    db.prepare(`
      INSERT INTO gene_capsules_coding (
        failure_code, category, pattern,
        typical_files, issue_keywords,
        strategy, hint,
        q_value, success_count,
        source_issue_number, source_repo,
        shareable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.perceiveResult.failure_code,
      input.perceiveResult.category,
      input.perceiveResult.keywords.join('|'),
      JSON.stringify(input.filesChanged),
      JSON.stringify(input.perceiveResult.keywords),
      input.strategy,
      hint,
      0.7,
      1,
      input.issueNumber,
      input.repoName,
      0,
    );
  }
}

function buildHintFromStrategy(strategy: string, failure_code: string): string {
  const hints: Record<string, string> = {
    'string-comparison-missing-normalization':
      'Add a normalize function that strips spaces/dashes/underscores and lowercases before comparing strings.',
    'error-not-handled':
      'Wrap the throwing call in try/catch. Return appropriate HTTP status (404 for not found, 400 for bad input, 500 for unexpected).',
    'null-not-checked':
      'Add null/undefined check before accessing properties. Use optional chaining (?.) or explicit if-check.',
    'regex-too-strict':
      'Review and update the regex character class to include valid characters that are currently excluded.',
    'missing-return-status':
      'Return the correct HTTP status code. Use res.status(404).json({}) for not found, not res.status(500).',
  };
  return hints[failure_code] || `Applied strategy: ${strategy}. Check the diff for the fix pattern.`;
}

function mergeFiles(existing: string[], newFiles: string[]): string[] {
  const all = [...new Set([...existing, ...newFiles])];
  return all.slice(0, 10);
}
