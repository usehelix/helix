import { describe, it, expect } from 'vitest';
import { buildConstructPrompt, buildTracesSection } from '../src/engine/llm.js';
import type { FailureClassification, TraceEntry } from '../src/engine/types.js';

const FAILURE: FailureClassification = {
  code: 'rate-limited',
  category: 'auth',
  severity: 'medium',
  platform: 'generic',
  details: '429 Too Many Requests on rpc.example.com',
  timestamp: 1700000000000,
};

const ERROR_MSG = '429 Too Many Requests on rpc.example.com';

// The legacy prompt as it shipped before trace-awareness — used to assert
// byte-identical fallback when traces is empty.
const LEGACY_USER = `Error: code="rate-limited", category="auth", severity="medium"\nMessage: "${ERROR_MSG}"\nPick 1-3 strategies. JSON array only.`;
const LEGACY_SYSTEM_TAIL = `Rules: ONLY exact names from above. confidence 0.1-0.7. Prefer Category A. JSON array only, no markdown:\n[{"strategy":"name","confidence":0.5,"reasoning":"why"}]`;

describe('buildConstructPrompt — trace-aware fallback', () => {
  it('cold-start (no traces) → user prompt has no history section, system has no HISTORY block', () => {
    const { system, user } = buildConstructPrompt(FAILURE, ERROR_MSG, []);

    // System: header + rules, no history block, no [SAMECODE] cues
    expect(system).toContain('You select repair strategies');
    expect(system).toContain('Category D (orchestration)');
    expect(system).toContain(LEGACY_SYSTEM_TAIL);
    expect(system).not.toContain('RECENT EXECUTION HISTORY');
    expect(system).not.toContain('[SAMECODE]');
    expect(system).not.toContain('Use this history to:');

    // User: byte-identical to legacy
    expect(user).toBe(LEGACY_USER);
    expect(user).not.toContain('Recent execution history');
  });

  it('3 SAMECODE traces → 3 [SAMECODE] rows, recency-desc, ✓/✗ + q transitions', () => {
    const now = 1700000000000;
    const traces: TraceEntry[] = [
      { tag: 'SAMECODE', timestamp: now - 4 * 3600_000, failureCode: 'rate-limited', failureCategory: 'auth', strategy: 'retry', success: false, immune: false, durationMs: 5012, qBefore: 0.30, qAfter: 0.18, repairError: 'still 429 after retry' },
      { tag: 'SAMECODE', timestamp: now - 6 * 3600_000, failureCode: 'rate-limited', failureCategory: 'auth', strategy: 'switch_endpoint', success: true, immune: false, durationMs: 920, qBefore: 0.55, qAfter: 0.71 },
      { tag: 'SAMECODE', timestamp: now - 2 * 3600_000, failureCode: 'rate-limited', failureCategory: 'auth', strategy: 'backoff_retry', success: true, immune: false, durationMs: 1842, qBefore: 0.45, qAfter: 0.62 },
    ];
    const { system, user } = buildConstructPrompt(FAILURE, ERROR_MSG, traces, now);

    // System: HEADER + HISTORY + RULES — all three present, in order
    expect(system).toContain('Category D (orchestration)');
    expect(system).toContain('RECENT EXECUTION HISTORY');
    expect(system).toContain('Use this history to:');
    expect(system).toContain(LEGACY_SYSTEM_TAIL);
    expect(system.indexOf('Category D')).toBeLessThan(system.indexOf('RECENT EXECUTION HISTORY'));
    expect(system.indexOf('RECENT EXECUTION HISTORY')).toBeLessThan(system.indexOf('Rules: ONLY exact names'));

    // User: tracesSection wedged between Message and "Pick"
    expect(user).toContain('Recent execution history:');
    expect(user).toContain('[SAMECODE] 2h ago · backoff_retry · ✓ · 1842ms · q: 0.45→0.62');
    expect(user).toContain('[SAMECODE] 4h ago · retry · ✗ · 5012ms · q: 0.30→0.18 · (still 429 after retry)');
    expect(user).toContain('[SAMECODE] 6h ago · switch_endpoint · ✓ · 920ms · q: 0.55→0.71');
    expect(user).not.toContain('[CATEGORY]');

    // Recency: 2h before 4h before 6h
    const i2 = user.indexOf('2h ago');
    const i4 = user.indexOf('4h ago');
    const i6 = user.indexOf('6h ago');
    expect(i2).toBeGreaterThan(0);
    expect(i2).toBeLessThan(i4);
    expect(i4).toBeLessThan(i6);

    // User still ends with the JSON instruction
    expect(user.endsWith('Pick 1-3 strategies. JSON array only.')).toBe(true);
  });

  it('1 SAMECODE + 2 CATEGORY → SAMECODE block first, CATEGORY rows include failure_code', () => {
    const now = 1700000000000;
    const traces: TraceEntry[] = [
      { tag: 'CATEGORY', timestamp: now - 1 * 3600_000, failureCode: 'rate-limit-rpc', failureCategory: 'auth', strategy: 'backoff_retry', success: true, immune: false, durationMs: 2103, qBefore: 0.40, qAfter: 0.55 },
      { tag: 'SAMECODE', timestamp: now - 30 * 60_000, failureCode: 'rate-limited', failureCategory: 'auth', strategy: 'switch_endpoint', success: true, immune: false, durationMs: 800, qBefore: 0.50, qAfter: 0.62 },
      { tag: 'CATEGORY', timestamp: now - 2 * 3600_000, failureCode: 'auth-expired', failureCategory: 'auth', strategy: 'renew_session', success: false, immune: false, durationMs: 1500, qBefore: 0.40, qAfter: 0.30, repairError: 'token still rejected' },
    ];
    const { user } = buildTracesSectionViaPrompt(traces, now);

    // SAMECODE block precedes CATEGORY block
    const idxSame = user.indexOf('[SAMECODE]');
    const idxCat = user.indexOf('[CATEGORY]');
    expect(idxSame).toBeGreaterThan(0);
    expect(idxCat).toBeGreaterThan(idxSame);

    // SAMECODE row: format does NOT include failure_code field
    expect(user).toContain('[SAMECODE] 30m ago · switch_endpoint · ✓ · 800ms · q: 0.50→0.62');

    // CATEGORY rows: include failure_code between time and strategy, recency-desc within block
    expect(user).toContain('[CATEGORY] 1h ago · rate-limit-rpc · backoff_retry · ✓ · 2103ms · q: 0.40→0.55');
    expect(user).toContain('[CATEGORY] 2h ago · auth-expired · renew_session · ✗ · 1500ms · q: 0.40→0.30 · (token still rejected)');
    const cat1h = user.indexOf('[CATEGORY] 1h ago');
    const cat2h = user.indexOf('[CATEGORY] 2h ago');
    expect(cat1h).toBeLessThan(cat2h);

    // Sanity: the standalone section builder agrees with the embedded version
    const section = buildTracesSection(traces, now);
    expect(section).toContain('[SAMECODE] 30m ago');
    expect(section).toContain('[CATEGORY] 1h ago · rate-limit-rpc');
  });
});

// Helper — re-exports buildConstructPrompt's user message under a shorter name
// used only inside this test for readability.
function buildTracesSectionViaPrompt(traces: TraceEntry[], now: number): { system: string; user: string } {
  return buildConstructPrompt(FAILURE, ERROR_MSG, traces, now);
}
