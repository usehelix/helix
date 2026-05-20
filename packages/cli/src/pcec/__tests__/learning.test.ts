import { evaluateHintUsage } from '../commit';

describe('evaluateHintUsage', () => {
  it('returns used when hint keywords appear in diff', () => {
    const hint = 'Add normalize function that strips whitespace and lowercases before comparison';
    // Realistic multi-line diff with comments + impl — matches `normalize`,
    // `function`, `strips`, `whitespace`, `comparison` → 5/6 keywords (83%).
    const diff = `+  // Strips whitespace and applies comparison-safe normalization
+  function normalize(s: string): string {
+    return s.toLowerCase().replace(/\\s/g, '');
+  }
+  if (normalize(a) === normalize(b)) { /* match */ }`;
    expect(evaluateHintUsage(hint, diff)).toBe('used');
  });

  it('returns ignored when hint keywords not in diff', () => {
    const hint = 'Add normalize function that strips whitespace';
    const diff = '+  try { } catch (err) { res.status(500).json({ error: err.message }) }';
    expect(evaluateHintUsage(hint, diff)).toBe('ignored');
  });

  it('returns not_applicable when no hint', () => {
    expect(evaluateHintUsage(undefined, 'some diff')).toBe('not_applicable');
  });

  it('returns not_applicable when diff is empty', () => {
    expect(evaluateHintUsage('some hint', '')).toBe('not_applicable');
  });

  it('returns not_applicable when hint has no significant words', () => {
    // All stop words / short words → no usable keywords
    expect(evaluateHintUsage('add the if', 'some diff')).toBe('not_applicable');
  });
});
