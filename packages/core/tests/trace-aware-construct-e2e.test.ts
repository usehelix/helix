import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GeneMap } from '../src/engine/gene-map.js';
import { llmConstructCandidates } from '../src/engine/llm.js';
import type { FailureClassification } from '../src/engine/types.js';

/**
 * End-to-end test for trace-aware Construct LLM fallback.
 *
 * Flow under test:
 *   recordAudit + recordFailedRepair          (3 prior attempts)
 *     → geneMap.getRecentTraces                (SAMECODE LEFT JOIN failed_repairs)
 *     → llmConstructCandidates(traces)         (build prompt, call LLM)
 *     → fetch is mocked, body is captured
 *     → assert prompt structure + that LLM (mocked) avoids the failed strategy
 *
 * Real LLM is never called. The mock proves the *prompt* contains the right
 * trace context; the strategy avoidance is the LLM contract we're verifying
 * the prompt enables (the mock itself returns a deterministic non-`retry`
 * response, mimicking what a competent LLM would do given the trace).
 */

describe('Trace-aware Construct e2e', () => {
  let gm: GeneMap;

  beforeEach(() => {
    gm = new GeneMap(':memory:');
    vi.useFakeTimers();
  });

  afterEach(() => {
    gm.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('LLM prompt contains SAMECODE traces with q-transitions; mocked LLM avoids the failed strategy', async () => {
    const agentId = 'test-agent-001';
    const code = 'rate-limited';
    const category = 'auth';
    const NOW = 1700000000000; // 2023-11-14T22:13:20Z — fixed anchor

    // ── Seed 3 prior attempts on the SAME error code ──
    // Spaced via fake timers so the relative-time formatter shows realistic
    // gaps in the eyeball-check prompt (vs all "0s ago" in same-tick recording).
    // Order of recordAudit calls determines audit.id (autoincrement) which
    // also serves as a tie-breaker when timestamps collide.

    // Oldest: switch_endpoint succeeded — 6h ago
    vi.setSystemTime(NOW - 6 * 3600_000);
    gm.recordAudit({
      agentId, errorMessage: '429 Too Many Requests',
      failureCode: code, failureCategory: category,
      strategy: 'switch_endpoint', immune: false, success: true,
      mode: 'test', durationMs: 920, qBefore: 0.55, qAfter: 0.71,
    });
    // Middle: retry FAILED (this is what the LLM should learn to avoid) — 4h ago
    vi.setSystemTime(NOW - 4 * 3600_000);
    gm.recordAudit({
      agentId, errorMessage: '429 Too Many Requests',
      failureCode: code, failureCategory: category,
      strategy: 'retry', immune: false, success: false,
      mode: 'test', durationMs: 5012, qBefore: 0.30, qAfter: 0.18,
    });
    gm.recordFailedRepair({
      failureCode: code, category, strategy: 'retry',
      error: '429 Too Many Requests', repairError: 'still 429 after retry',
    });
    // Most recent: backoff_retry succeeded — 2h ago
    vi.setSystemTime(NOW - 2 * 3600_000);
    gm.recordAudit({
      agentId, errorMessage: '429 Too Many Requests',
      failureCode: code, failureCategory: category,
      strategy: 'backoff_retry', immune: false, success: true,
      mode: 'test', durationMs: 1842, qBefore: 0.45, qAfter: 0.62,
    });

    // Anchor "now" so the formatter prints 2h/4h/6h ago in the demo prompt
    vi.setSystemTime(NOW);

    // ── Verify trace fetch returns all 3 with SAMECODE tag ──
    const traces = gm.getRecentTraces(code, category, agentId, 3);
    expect(traces.length).toBe(3);
    expect(traces.every(t => t.tag === 'SAMECODE')).toBe(true);
    // Most recent (backoff_retry) should be first
    expect(traces[0].strategy).toBe('backoff_retry');
    // The failed retry should carry the repairError from failed_repairs join
    const retryTrace = traces.find(t => t.strategy === 'retry')!;
    expect(retryTrace.success).toBe(false);
    expect(retryTrace.repairError).toBe('still 429 after retry');

    // ── Mock fetch and capture the request body sent to the LLM ──
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_url: any, init: any) => {
      // Simulate Anthropic returning two strategies, NEITHER of which is `retry`
      // (mimicking a competent LLM responding to the trace context).
      const llmReply = JSON.stringify([
        { strategy: 'switch_endpoint', confidence: 0.7, reasoning: 'history shows this works' },
        { strategy: 'backoff_retry', confidence: 0.6, reasoning: 'q is climbing on this code' },
      ]);
      return new Response(JSON.stringify({ content: [{ text: llmReply }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const failure: FailureClassification = {
      code, category, severity: 'medium', platform: 'generic',
      details: 'fresh 429 on rpc.example.com',
      timestamp: Date.now(),
    };

    const candidates = await llmConstructCandidates(
      failure,
      'fresh 429 on rpc.example.com',
      { enabled: true, apiKey: 'test-key', provider: 'anthropic' },
      traces,
    );

    // ── Verify the prompt actually carried trace context ──
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const reqInit = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(reqInit.body as string) as { system: string; messages: { content: string }[] };

    expect(body.system).toContain('RECENT EXECUTION HISTORY');
    expect(body.system).toContain('Use this history to:');

    const userMsg = body.messages[0].content;
    expect(userMsg).toContain('Recent execution history:');
    expect(userMsg).toContain('[SAMECODE]');
    expect(userMsg).toContain('backoff_retry');
    expect(userMsg).toContain('switch_endpoint');
    expect(userMsg).toContain('retry');
    expect(userMsg).toContain('✓');
    expect(userMsg).toContain('✗');
    expect(userMsg).toContain('q: 0.30→0.18');
    expect(userMsg).toContain('q: 0.45→0.62');
    expect(userMsg).toContain('still 429 after retry');

    // With spaced timestamps the formatter should render real "Xh ago"
    expect(userMsg).toContain('[SAMECODE] 2h ago · backoff_retry · ✓');
    expect(userMsg).toContain('[SAMECODE] 4h ago · retry · ✗');
    expect(userMsg).toContain('[SAMECODE] 6h ago · switch_endpoint · ✓');

    // ── Verify the (mocked) LLM choice ignored the failed strategy ──
    expect(candidates).not.toBeNull();
    const strategies = candidates!.map(c => c.strategy);
    expect(strategies).toContain('switch_endpoint');
    expect(strategies).toContain('backoff_retry');
    expect(strategies).not.toContain('retry');

    // ── Print the literal prompt for human review (one-time eyeball) ──
    // Test runner shows console output by default; this is the artifact the
    // user explicitly asked to see before commit.
    /* eslint-disable no-console */
    console.log('\n========== ACTUAL LLM SYSTEM PROMPT ==========\n' + body.system);
    console.log('\n========== ACTUAL LLM USER MESSAGE ==========\n' + userMsg);
    console.log('\n========== END PROMPT ==========\n');
    /* eslint-enable no-console */
  });
});
