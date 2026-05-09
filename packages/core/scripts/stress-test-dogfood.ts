#!/usr/bin/env npx tsx
/**
 * Gene Registry Cloud dogfood stress-test.
 *
 * Run TWICE with different HELIX_GENE_DB and STRESS_RUN_TAG values to validate
 * cross-machine procedural memory reuse:
 *
 *   # Run 1 — agent A, fresh local DB, will sync 100 capsules to Registry
 *   HELIX_GENE_DB=/tmp/run1.db GENE_REGISTRY_AGENT_ID=helix-core-mac-haimo \
 *     STRESS_RUN_TAG=dogfood-may8 \
 *     GENE_REGISTRY_URL=https://helix-telemetry.haimobai-adrian.workers.dev \
 *     GENE_REGISTRY_WRITE_KEY=$KEY \
 *     npx tsx packages/core/scripts/stress-test-dogfood.ts
 *
 *   # Run 2 — agent B, fresh local DB (no shared state with Run 1),
 *   # SAME STRESS_RUN_TAG so it queries the same codes Run 1 just synced.
 *   HELIX_GENE_DB=/tmp/run2.db GENE_REGISTRY_AGENT_ID=helix-core-mac-fresh-b \
 *     STRESS_RUN_TAG=dogfood-may8 \
 *     GENE_REGISTRY_URL=... GENE_REGISTRY_WRITE_KEY=$KEY \
 *     npx tsx packages/core/scripts/stress-test-dogfood.ts
 *
 * Test design:
 *   - 100 UNIQUE failure codes (`${runTag}-stress-${i}`) — ensures Local
 *     hits=0 in Run 2 (each code seen once per run, no in-run repetition).
 *   - LLM fetches mocked at the script level (returns `retry` strategy) so
 *     Construct fallback works without API keys or network cost.
 *   - Registry fetches go through to the real worker untouched.
 *
 * Required env: GENE_REGISTRY_URL, GENE_REGISTRY_WRITE_KEY.
 * Optional env: HELIX_GENE_DB (default: ./helix-stress.db),
 *               GENE_REGISTRY_AGENT_ID (default: stress-${pid}),
 *               STRESS_N (default: 100),
 *               STRESS_RUN_TAG (default: dogfood).
 */

import { PcecEngine } from '../src/engine/pcec.js';
import { GeneMap } from '../src/engine/gene-map.js';
import type { ErrorCode, FailureCategory, FailureClassification, Platform, PlatformAdapter, RepairCandidate } from '../src/engine/types.js';

const REGISTRY_URL = process.env.GENE_REGISTRY_URL;
const WRITE_KEY = process.env.GENE_REGISTRY_WRITE_KEY;
const AGENT_ID = process.env.GENE_REGISTRY_AGENT_ID ?? `stress-${process.pid}`;
const DB_PATH = process.env.HELIX_GENE_DB ?? './helix-stress.db';
const N_ERRORS = Number(process.env.STRESS_N ?? '100');
const RUN_TAG = process.env.STRESS_RUN_TAG ?? 'dogfood';

if (!REGISTRY_URL || !WRITE_KEY) {
  console.error('✗ GENE_REGISTRY_URL and GENE_REGISTRY_WRITE_KEY env vars are required.');
  process.exit(2);
}

// ── Mock fetch for LLM endpoints only ──
// Patch global.fetch with a URL-aware shim. Returns canned `retry` strategy
// for LLM API calls; lets all other URLs (including the Registry worker)
// pass through to real fetch.
const realFetch = globalThis.fetch;
let llmCallsCanned = 0;
globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
  const url = typeof input === 'string' ? input : (input?.url ?? '');
  if (url.includes('api.anthropic.com')) {
    llmCallsCanned++;
    const body = JSON.stringify([{ strategy: 'retry', confidence: 0.5, reasoning: 'mock LLM' }]);
    return new Response(JSON.stringify({ content: [{ text: body }] }), { status: 200 });
  }
  if (url.includes('api.openai.com')) {
    llmCallsCanned++;
    const body = JSON.stringify([{ strategy: 'retry', confidence: 0.5, reasoning: 'mock LLM' }]);
    return new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

// ── Stress adapter ──
// Reads the pre-built classification from context._stressFailure so PCEC
// uses our synthetic codes verbatim instead of running auto-detect on the
// error message (which might match real patterns and break uniqueness).
// Returns no candidates from construct() so the LLM fallback (or Registry
// hit) becomes the only source of strategies.
const stressAdapter: PlatformAdapter = {
  name: 'generic' as Platform,
  perceive(_error: Error, context?: Record<string, unknown>): FailureClassification | null {
    const forced = context?._stressFailure as FailureClassification | undefined;
    return forced ?? null;
  },
  construct(_failure: FailureClassification): RepairCandidate[] {
    return [];
  },
};

// ── Engine setup ──
const geneMap = new GeneMap(DB_PATH);
const engine = new PcecEngine(geneMap, AGENT_ID, {
  llm: { enabled: true, apiKey: 'fake-key-mocked-by-script', provider: 'anthropic' },
  registry: { url: REGISTRY_URL, writeKey: WRITE_KEY, agentId: AGENT_ID },
});
engine.registerAdapter(stressAdapter);

const t0 = Date.now();
let successes = 0;
let failures = 0;

console.log(`→ Stress test: ${N_ERRORS} unique failures, agent=${AGENT_ID}, db=${DB_PATH}`);
console.log(`  Registry: ${REGISTRY_URL}`);
console.log(`  Run tag:  ${RUN_TAG}`);
console.log();

for (let i = 0; i < N_ERRORS; i++) {
  const code = `${RUN_TAG}-stress-${i.toString().padStart(3, '0')}`;
  const category: FailureCategory = (['service', 'auth', 'network', 'session', 'batch'] as FailureCategory[])[i % 5];
  const platform: Platform = (['generic', 'tempo', 'privy', 'coinbase'] as Platform[])[i % 4];

  const error = new Error(`synthetic stress error #${i} code=${code}`);
  const forced: FailureClassification = {
    code: code as unknown as ErrorCode,
    category,
    severity: 'medium',
    platform,
    details: error.message,
    timestamp: Date.now(),
  };

  try {
    const result = await engine.repair(error, {
      _stressFailure: forced,
      platform,
    });
    if (result.success) successes++;
    else failures++;
  } catch {
    failures++;
  }

  if ((i + 1) % 10 === 0) {
    process.stdout.write(`  · ${i + 1}/${N_ERRORS}\r`);
  }
}

const totalMs = Date.now() - t0;
console.log(`  ${N_ERRORS}/${N_ERRORS} done in ${(totalMs / 1000).toFixed(1)}s`);

// Wait briefly for fire-and-forget Registry pushes to settle.
await new Promise(r => setTimeout(r, 1500));

const m = engine.getMetrics();

const pad = (s: string | number, w: number) => String(s).padEnd(w);
const block = [
  '┌─────────────────────────────────────────┐',
  '│ Stress Test Results                     │',
  '├─────────────────────────────────────────┤',
  `│ Errors injected:        ${pad(N_ERRORS, 16)}│`,
  `│ Local Gene Map hits:    ${pad(m.immuneHits, 16)}│`,
  `│ Registry queries:       ${pad(m.registryQueryCount, 16)}│`,
  `│ Registry hits:          ${pad(m.registryQueryHits, 16)}│`,
  `│ Registry timeouts:      ${pad(m.registryQueryTimeouts, 16)}│`,
  `│ LLM Construct calls:    ${pad(m.llmConstructCalls, 16)}│`,
  `│ Successful repairs:     ${pad(successes, 16)}│`,
  `│ Capsules synced:        ${pad(m.registrySyncCount, 16)}│`,
  `│ Sync failures:          ${pad(m.registrySyncFailures, 16)}│`,
  `│ Total time:             ${pad((totalMs / 1000).toFixed(1) + 's', 16)}│`,
  '└─────────────────────────────────────────┘',
];
console.log();
console.log(block.join('\n'));

const json = {
  agentId: AGENT_ID,
  dbPath: DB_PATH,
  runTag: RUN_TAG,
  errorsInjected: N_ERRORS,
  successfulRepairs: successes,
  repairFailures: failures,
  totalMs,
  llmCallsCanned,
  metrics: m,
};
console.log('---JSON---');
console.log(JSON.stringify(json, null, 2));

geneMap.close();
process.exit(0);
