/**
 * LLM Fallback — Classifies unknown errors when string matching fails.
 * Supports Anthropic Claude and OpenAI GPT. Results cached in Gene Map.
 */

import type { FailureClassification, ErrorCode, FailureCategory, Severity, Platform, RepairCandidate, TraceEntry } from './types.js';

export interface LlmConfig {
  /** Primary provider. Default: 'anthropic' */
  provider?: 'anthropic' | 'openai';
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  enabled?: boolean;
  /** Fallback API key (OpenAI). Used when primary (Claude) fails. */
  fallbackApiKey?: string;
}

const CODES: ErrorCode[] = ['verification-failed', 'payment-insufficient', 'rate-limited', 'timeout', 'tx-reverted', 'method-unsupported', 'policy-violation', 'token-uninitialized', 'server-error', 'malformed-credential', 'invalid-challenge', 'unknown'];
const CATS: FailureCategory[] = ['signature', 'balance', 'auth', 'service', 'batch', 'currency', 'policy', 'network', 'session', 'dex', 'compliance', 'unknown'];
const SEVS: Severity[] = ['low', 'medium', 'high', 'critical'];

const SYSTEM = `You classify payment/blockchain errors for AI agents. Respond with ONLY valid JSON, no markdown:
{"code":"<one of: ${CODES.join(', ')}>","category":"<one of: ${CATS.join(', ')}>","severity":"<low|medium|high|critical>","reasoning":"one sentence"}

Guide:
- nonce/signature/verification → verification-failed + signature
- insufficient funds/balance → payment-insufficient + balance
- 429/rate limit → rate-limited + auth
- timeout/ETIMEDOUT → timeout + service
- reverted/out of gas → tx-reverted + batch
- policy/spending limit → policy-violation + policy
- wrong network/chain → token-uninitialized + network
- session/expired → invalid-challenge + session
- 500/502/503 → server-error + service
- malformed/invalid params → malformed-credential + service`;

export async function llmClassify(errorMessage: string, config: LlmConfig, fewShotPrompt?: string): Promise<FailureClassification | null> {
  if (config.enabled === false) return null;

  const provider = config.provider ?? 'anthropic';
  const primaryKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.HELIX_LLM_API_KEY;
  const fallbackKey = config.fallbackApiKey ?? process.env.OPENAI_API_KEY;

  if (!primaryKey && !fallbackKey) return null;

  // Try primary (default: Claude)
  if (primaryKey) {
    const result = await tryLlm(errorMessage, provider, primaryKey, config.model, config.timeoutMs, fewShotPrompt);
    if (result) return result;
  }

  // Fallback to the other provider
  if (fallbackKey && provider === 'anthropic') {
    const result = await tryLlm(errorMessage, 'openai', fallbackKey, undefined, config.timeoutMs, fewShotPrompt);
    if (result) return result;
  } else if (fallbackKey && provider === 'openai') {
    const result = await tryLlm(errorMessage, 'anthropic', fallbackKey, undefined, config.timeoutMs, fewShotPrompt);
    if (result) return result;
  }

  return null;
}

async function tryLlm(errorMessage: string, provider: 'anthropic' | 'openai', apiKey: string, model: string | undefined, timeoutMs: number | undefined, fewShotPrompt?: string): Promise<FailureClassification | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? 8000);
  try {
    const systemPrompt = fewShotPrompt ? SYSTEM + fewShotPrompt : SYSTEM;
    const text = provider === 'anthropic'
      ? await callAnthropic(errorMessage, apiKey, model, ctrl.signal, systemPrompt)
      : await callOpenAI(errorMessage, apiKey, model, ctrl.signal, systemPrompt);
    clearTimeout(timer);
    const p = JSON.parse(text.trim().replace(/```json\n?|```/g, ''));
    return {
      code: (CODES.includes(p.code) ? p.code : 'unknown') as ErrorCode,
      category: (CATS.includes(p.category) ? p.category : 'unknown') as FailureCategory,
      severity: (SEVS.includes(p.severity) ? p.severity : 'medium') as Severity,
      platform: 'generic' as Platform,
      details: errorMessage,
      timestamp: Date.now(),
      llmClassified: true,
      llmReasoning: p.reasoning ?? '',
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function callAnthropic(msg: string, key: string, model: string | undefined, signal: AbortSignal, systemPrompt = SYSTEM): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model ?? 'claude-sonnet-4-20250514', max_tokens: 150, system: systemPrompt, messages: [{ role: 'user', content: `Classify this error:\n"${msg}"` }] }),
    signal,
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const d = await r.json() as { content?: { text: string }[] };
  return d.content?.[0]?.text ?? '';
}

async function callOpenAI(msg: string, key: string, model: string | undefined, signal: AbortSignal, systemPrompt = SYSTEM): Promise<string> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: model ?? 'gpt-4o-mini', max_tokens: 150, temperature: 0, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `Classify this error:\n"${msg}"` }] }),
    signal,
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const d = await r.json() as { choices?: { message: { content: string } }[] };
  return d.choices?.[0]?.message?.content ?? '';
}

export async function llmGenerateReasoning(errorMessage: string, strategy: string, config: LlmConfig): Promise<string | null> {
  if (config.enabled === false) return null;
  const provider = config.provider ?? 'anthropic';
  const key = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.HELIX_LLM_API_KEY;
  if (!key) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs ?? 8000);
  const userMsg = `Error: "${errorMessage}"\nRepaired with: "${strategy}"\nIn one plain-text sentence (no JSON, no markdown), explain WHY this strategy fixes this error.`;
  const sysMsg = 'You explain why a repair strategy works for a given error. Respond with ONE plain-text sentence only. No JSON, no markdown, no quotes.';

  try {
    let text: string;
    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: config.model ?? 'claude-sonnet-4-20250514', max_tokens: 150, system: sysMsg, messages: [{ role: 'user', content: userMsg }] }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`${r.status}`);
      const d = await r.json() as { content?: { text: string }[] };
      text = d.content?.[0]?.text ?? '';
    } else {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model: config.model ?? 'gpt-4o-mini', max_tokens: 150, temperature: 0, messages: [{ role: 'system', content: sysMsg }, { role: 'user', content: userMsg }] }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`${r.status}`);
      const d = await r.json() as { choices?: { message: { content: string } }[] };
      text = d.choices?.[0]?.message?.content ?? '';
    }
    clearTimeout(timer);
    const cleaned = text.trim().replace(/^["']|["']$/g, '').replace(/```\w*\n?|```/g, '').trim().slice(0, 300);
    return cleaned.length > 10 ? cleaned : null;
  } catch { clearTimeout(timer); return null; }
}

// ── LLM Construct: suggest strategies for unknown errors ──

const VALID_STRATEGIES = [
  'backoff_retry', 'retry', 'retry_with_receipt', 'reduce_request',
  'fix_params', 'switch_endpoint', 'hold_and_notify', 'extend_deadline',
  'refresh_nonce', 'switch_network', 'get_balance',
  'self_pay_gas', 'cancel_pending_txs', 'speed_up_transaction',
  'split_transaction', 'swap_currency', 'topup_from_reserve',
  'renew_session', 'remove_and_resubmit', 'refund_waterfall', 'switch_service',
  // Circle-specific (validated in Nanopayments Exp A2/C2, Apr 2026)
  'serialize_and_backoff', 'burst_then_pace', 'rotate_authorization', 'wait_attestation',
  // Experimentally-validated (Apr 2026, Arc Testnet)
  'override_api_decimals',
];

// System prompt split into composable sections so the trace-aware variant
// can inject HISTORY between HEADER and RULES without duplicating the
// strategy category list. When no traces exist, HEADER + RULES is byte-
// identical to the original CONSTRUCT_SYS prompt (verify in unit test).

const CONSTRUCT_SYS_HEADER = `You select repair strategies for AI agent payment errors. Pick 1-3 from:
Category A (safe): backoff_retry, retry, retry_with_receipt, reduce_request, fix_params, switch_endpoint, hold_and_notify, extend_deadline
Category B (chain read): refresh_nonce, switch_network, get_balance
Category C (chain write): self_pay_gas, cancel_pending_txs, speed_up_transaction, split_transaction, swap_currency, topup_from_reserve
Category D (orchestration): renew_session, remove_and_resubmit, refund_waterfall, switch_service`;

const CONSTRUCT_SYS_HISTORY = `Below you may see RECENT EXECUTION HISTORY for this agent on this error.
- [SAMECODE] = prior attempts on the EXACT same error code (most relevant)
- [CATEGORY] = attempts on different errors in same category (broader pattern, may not transfer)
- "✓" = strategy succeeded, "✗" = strategy failed (with reason if available)
- "q: A→B" = Q-value before/after; rising q means the strategy is gaining trust

Use this history to:
1. AVOID strategies that just failed on the same code (unless you have a different param idea)
2. PREFER strategies whose q is climbing
3. NOTE why a strategy failed — sometimes same strategy works with different approach`;

const CONSTRUCT_SYS_RULES = `Rules: ONLY exact names from above. confidence 0.1-0.7. Prefer Category A. JSON array only, no markdown:
[{"strategy":"name","confidence":0.5,"reasoning":"why"}]`;

/** Inline relative-time formatter — no date-fns/dayjs dep. */
function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Render a TraceEntry[] into the human-readable section that goes into
 * the LLM user message. Returns '' when traces is empty so callers can
 * fall through to the legacy prompt without branching.
 *
 * Hard cap of 4 rows. SAMECODE rows always appear before CATEGORY rows;
 * within each tag, sorted by recency descending.
 */
export function buildTracesSection(traces: TraceEntry[], now: number = Date.now()): string {
  if (!traces || traces.length === 0) return '';
  const tagRank = (t: TraceEntry) => (t.tag === 'SAMECODE' ? 0 : 1);
  const sorted = [...traces]
    .sort((a, b) => tagRank(a) - tagRank(b) || b.timestamp - a.timestamp)
    .slice(0, 4);

  const lines = sorted.map(t => {
    const time = formatRelativeTime(t.timestamp, now);
    const outcome = t.success ? '✓' : '✗';
    const qBefore = (t.qBefore != null) ? Number(t.qBefore).toFixed(2) : '?';
    const qAfter = (t.qAfter != null) ? Number(t.qAfter).toFixed(2) : '?';
    const errSuffix = (!t.success && t.repairError) ? ` · (${t.repairError.slice(0, 60)})` : '';
    const tail = `${outcome} · ${t.durationMs}ms · q: ${qBefore}→${qAfter}${errSuffix}`;
    if (t.tag === 'CATEGORY') {
      return `[CATEGORY] ${time} · ${t.failureCode} · ${t.strategy} · ${tail}`;
    }
    return `[SAMECODE] ${time} · ${t.strategy} · ${tail}`;
  });

  return `Recent execution history:\n${lines.join('\n')}`;
}

/**
 * Build the {system, user} pair for the Construct LLM call.
 * When `traces` is empty, the result is byte-identical to the legacy
 * prompt (asserted in unit test). When traces exist, HISTORY guidance
 * is appended to system and a tracesSection is wedged into user.
 */
export function buildConstructPrompt(
  failure: FailureClassification,
  errorMessage: string,
  traces: TraceEntry[] = [],
  now: number = Date.now(),
): { system: string; user: string } {
  const tracesSection = buildTracesSection(traces, now);
  const baseUser = `Error: code="${failure.code}", category="${failure.category}", severity="${failure.severity}"\nMessage: "${errorMessage.slice(0, 200)}"`;
  if (!tracesSection) {
    return {
      system: `${CONSTRUCT_SYS_HEADER}\n\n${CONSTRUCT_SYS_RULES}`,
      user: `${baseUser}\nPick 1-3 strategies. JSON array only.`,
    };
  }
  return {
    system: `${CONSTRUCT_SYS_HEADER}\n\n${CONSTRUCT_SYS_HISTORY}\n\n${CONSTRUCT_SYS_RULES}`,
    user: `${baseUser}\n\n${tracesSection}\n\nPick 1-3 strategies. JSON array only.`,
  };
}

export async function llmConstructCandidates(
  failure: FailureClassification,
  errorMessage: string,
  config: LlmConfig,
  traces: TraceEntry[] = [],
): Promise<RepairCandidate[] | null> {
  if (config.enabled === false) return null;
  const provider = config.provider ?? 'anthropic';
  const key = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.HELIX_LLM_API_KEY;
  if (!key) return null;

  // Trace-aware prompt — empty traces ⇒ legacy format (byte-identical).
  const { system, user: userMsg } = buildConstructPrompt(failure, errorMessage, traces);
  // Modest bump to account for trace context. Legacy used 200; raise to 300
  // when traces present to avoid clipping a 3-strategy reply.
  const maxTokens = traces.length > 0 ? 300 : 200;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs ?? 8000);

  try {
    let text: string;
    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: config.model ?? 'claude-sonnet-4-20250514', max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMsg }] }), signal: ctrl.signal });
      if (!r.ok) throw new Error(`${r.status}`);
      const d = await r.json() as { content?: { text: string }[] };
      text = d.content?.[0]?.text ?? '';
    } else {
      const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` }, body: JSON.stringify({ model: config.model ?? 'gpt-4o-mini', max_tokens: maxTokens, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }] }), signal: ctrl.signal });
      if (!r.ok) throw new Error(`${r.status}`);
      const d = await r.json() as { choices?: { message: { content: string } }[] };
      text = d.choices?.[0]?.message?.content ?? '';
    }
    clearTimeout(timer);

    const parsed = JSON.parse(text.trim().replace(/```json\n?|```/g, ''));
    if (!Array.isArray(parsed)) return null;

    const candidates: RepairCandidate[] = parsed
      .filter((c: any) => c.strategy && VALID_STRATEGIES.includes(c.strategy))
      .map((c: any) => ({
        id: `llm_${c.strategy}`, strategy: c.strategy,
        description: String(c.reasoning ?? `LLM suggested: ${c.strategy}`).slice(0, 200),
        estimatedCostUsd: /swap|topup|self_pay|speed_up|cancel/.test(c.strategy) ? 0.05 : 0,
        estimatedSpeedMs: c.strategy === 'backoff_retry' ? 2000 : c.strategy === 'retry_with_receipt' ? 1000 : 500,
        requirements: [], score: 0,
        successProbability: Math.min(0.7, Math.max(0.1, Number(c.confidence) || 0.5)),
        platform: 'generic' as Platform,
        source: 'llm' as const,
        reasoning: String(c.reasoning ?? '').slice(0, 200),
      }))
      .slice(0, 3);

    return candidates.length > 0 ? candidates : null;
  } catch { clearTimeout(timer); return null; }
}
