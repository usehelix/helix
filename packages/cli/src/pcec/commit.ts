import type Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { PerceiveResult } from './perceive';
import { openGeneMap } from './db';

export type HintUsage = 'used' | 'ignored' | 'not_applicable';

export interface CommitInput {
  perceiveResult: PerceiveResult;
  strategy: string;
  filesChanged: string[];
  /** Full unified diff from `git diff HEAD~1`. Used for hint-usage scoring. */
  actualDiff?: string;
  /** The hint string from the matched capsule (if Gene Map hit). */
  capsuleHint?: string;
  prUrl: string;
  success: boolean;
  repoName: string;
  issueNumber: number;
  /** Where the issue lives — 'github' | 'jira' | 'linear'. */
  issueSource?: string;
  /** Source-specific id ('123' for GH, 'HELIX-1' for Jira). */
  issueId?: string;
}

const STOP_WORDS = new Set([
  'add', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of',
  'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'can', 'could', 'should', 'may', 'might', 'it', 'this', 'that',
  'with', 'from', 'by', 'as', 'if', 'when', 'then', 'before',
  'after', 'use', 'using', 'make', 'ensure', 'check', 'return',
]);

/**
 * Detect whether Claude's diff actually uses keywords from the capsule hint.
 * Pure string match, zero LLM cost. ≥30% keyword overlap → 'used'.
 */
export function evaluateHintUsage(
  capsuleHint: string | undefined,
  actualDiff: string,
): HintUsage {
  if (!capsuleHint) return 'not_applicable';
  if (!actualDiff || actualDiff.trim().length === 0) return 'not_applicable';

  const hintWords = capsuleHint
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));

  if (hintWords.length === 0) return 'not_applicable';

  const diffLower = actualDiff.toLowerCase();
  const matchedWords = hintWords.filter(w => diffLower.includes(w));
  const matchRate = matchedWords.length / hintWords.length;

  return matchRate >= 0.3 ? 'used' : 'ignored';
}

export function commit(db: Database.Database, input: CommitInput): void {
  if (!input.success) {
    const existing = db.prepare(`
      SELECT id, q_value FROM gene_capsules_coding WHERE failure_code = ?
    `).get(input.perceiveResult.failure_code) as { id: number; q_value: number } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE gene_capsules_coding
        SET q_value = MAX(0.1, q_value - 0.1),
            failure_count = failure_count + 1,
            updated_at = datetime('now')
        WHERE failure_code = ?
      `).run(input.perceiveResult.failure_code);
    }
    return;
  }

  // Successful fix: q_value increase is rate-adjusted by hint usage.
  const hintUsage = evaluateHintUsage(input.capsuleHint, input.actualDiff || '');

  // Learning rate:
  //   'used'        → +15% — capsule's hint matched Claude's actual approach
  //   'ignored'     → +5%  — possible misclassification (hint didn't help)
  //   'not_applicable' → +10% — no hint to evaluate (first-ever capsule)
  const learningRate =
    hintUsage === 'used' ? 0.15 :
    hintUsage === 'ignored' ? 0.05 :
    0.10;

  const existing = db.prepare(`
    SELECT id, q_value, success_count, typical_files
    FROM gene_capsules_coding WHERE failure_code = ?
  `).get(input.perceiveResult.failure_code) as { id: number; q_value: number; success_count: number; typical_files: string | null } | undefined;

  if (existing) {
    const newQ = Math.min(0.98, existing.q_value + (1 - existing.q_value) * learningRate);
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
    const hint = buildHintFromStrategy(input.strategy, input.perceiveResult.failure_code);
    db.prepare(`
      INSERT INTO gene_capsules_coding (
        failure_code, category, pattern,
        typical_files, issue_keywords,
        strategy, hint,
        q_value, success_count,
        source_issue_number, source_repo,
        shareable,
        issue_source, issue_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.issueSource ?? 'github',
      input.issueId ?? String(input.issueNumber),
    );
  }

  // Track hint usage counters (separate UPDATE — table may not have these columns
  // on very old DBs; wrap in try/catch so commit never aborts mid-flight).
  try {
    if (hintUsage === 'used') {
      db.prepare(`UPDATE gene_capsules_coding SET hint_used_count = hint_used_count + 1 WHERE failure_code = ?`)
        .run(input.perceiveResult.failure_code);
    } else if (hintUsage === 'ignored') {
      db.prepare(`UPDATE gene_capsules_coding SET hint_ignored_count = hint_ignored_count + 1 WHERE failure_code = ?`)
        .run(input.perceiveResult.failure_code);
    }
  } catch { /* columns missing on very old DBs — non-fatal */ }
}

/**
 * Reverse classification learning: after a fix, ask Haiku to look at the actual
 * diff and infer what bug type was REALLY fixed. If different from what perceive()
 * said, nudge q_values to correct the Gene Map.
 *
 * Opens its own DB connection so it's safe to call fire-and-forget after the
 * main `commit()` call has closed its db.
 */
export async function detectAndCorrectMisclassification(
  perceivedCode: string,
  actualDiff: string,
  issueTitle: string,
): Promise<{ corrected: boolean; actualCode?: string }> {
  if (!actualDiff || actualDiff.trim().length < 50) {
    return { corrected: false };
  }

  let actualCode: string;
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: `Issue: "${issueTitle}"

Diff (first 400 chars):
${actualDiff.slice(0, 400)}

What bug type does this fix? Pick exactly one:
regex-too-strict, error-not-handled, null-not-checked,
string-comparison-missing-normalization, missing-return-status,
async-not-awaited, race-condition, missing-validation,
off-by-one, memory-leak, type-mismatch, other

Reply with ONLY the bug type, nothing else.`,
      }],
    });

    actualCode = (response.content[0].type === 'text' ? response.content[0].text : '')
      .trim()
      .toLowerCase();
  } catch {
    return { corrected: false };
  }

  if (!actualCode || actualCode === perceivedCode || actualCode === 'other') {
    return { corrected: false };
  }

  // Open a fresh DB connection (caller's connection is already closed).
  const db = openGeneMap();
  try {
    // 1. Soften the misclassified capsule.
    db.prepare(`
      UPDATE gene_capsules_coding
      SET q_value = MAX(0.1, q_value - 0.08),
          updated_at = datetime('now')
      WHERE failure_code = ?
    `).run(perceivedCode);

    // 2. Reinforce / create the correct capsule.
    const existingCorrect = db.prepare(`
      SELECT id, q_value FROM gene_capsules_coding WHERE failure_code = ?
    `).get(actualCode) as { id: number; q_value: number } | undefined;

    if (existingCorrect) {
      db.prepare(`
        UPDATE gene_capsules_coding
        SET q_value = MIN(0.98, q_value + 0.05),
            success_count = success_count + 1,
            updated_at = datetime('now')
        WHERE failure_code = ?
      `).run(actualCode);
    } else {
      db.prepare(`
        INSERT INTO gene_capsules_coding (
          failure_code, category, strategy, hint, q_value, success_count
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        actualCode,
        actualCode.split('-')[0],
        'inferred_from_diff',
        `Auto-learned from misclassification correction. Original perceived as: ${perceivedCode}`,
        0.5,
        1,
      );
    }
  } finally {
    db.close();
  }

  return { corrected: true, actualCode };
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
