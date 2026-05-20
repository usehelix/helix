import type Database from 'better-sqlite3';

export interface Capsule {
  failure_code: string;
  strategy: string;
  hint: string;
  example_fix?: string;
  q_value: number;
  success_count: number;
}

export interface CapsuleHit {
  found: boolean;
  capsule?: Capsule;
}

export function construct(
  db: Database.Database,
  failure_code: string,
  min_q_value = 0.5,
): CapsuleHit {
  if (failure_code === 'unknown-bug-type') {
    return { found: false };
  }

  const capsule = db.prepare(`
    SELECT failure_code, strategy, hint, example_fix, q_value, success_count
    FROM gene_capsules_coding
    WHERE failure_code = ?
      AND q_value >= ?
    ORDER BY q_value DESC
    LIMIT 1
  `).get(failure_code, min_q_value) as Capsule | undefined;

  if (!capsule) return { found: false };

  // Bump usage count — separate from success_count which only increments on commit().
  db.prepare(`
    UPDATE gene_capsules_coding
    SET total_uses = total_uses + 1,
        updated_at = datetime('now')
    WHERE failure_code = ?
  `).run(failure_code);

  return { found: true, capsule };
}

export function buildPromptWithCapsule(basePrompt: string, hit: CapsuleHit): string {
  if (!hit.found || !hit.capsule) return basePrompt;

  const { capsule } = hit;
  const hint = `--- Gene Map Context (confidence: ${Math.round(capsule.q_value * 100)}%) ---
Bug type: ${capsule.failure_code}
Strategy: ${capsule.strategy}
Hint: ${capsule.hint}
${capsule.example_fix ? `Example fix pattern:\n${capsule.example_fix}\n` : ''}Validated by: ${capsule.success_count} previous successful fixes
--- End Gene Map Context ---

`;
  return hint + basePrompt;
}
