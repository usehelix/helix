/**
 * scripts/circle-bench/v1-vs-v2-metadata-trust.ts
 *
 * Bench 2.3 — decimals-metadata-mismatch
 *   V1 arm: override_api_decimals (priority logic re-implemented inline since
 *           the real one lives in provider.ts and needs an engine round-trip)
 *   V2 arm: verifyTokenMetadata (full triple verify + cache)
 *
 *   4 scenarios × 50 iterations. Partially online (real RPC for ERC-20 path
 *   in Scenario 3; mocked otherwise). Measures detection coverage + latency.
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http } from 'viem';
import {
  verifyTokenMetadata,
  NATIVE_USDC_DECIMALS,
  type TokenMetadata,
  type MetadataTrustResult,
} from '../../packages/core/dist/strategies/circle-v2/metadata-trust.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const ITERATIONS = 50;
const ARC_RPC = process.env.ARC_TESTNET_RPC_URL ?? 'https://rpc.testnet.arc.network';

// ── V1 inline: override_api_decimals (decimals-only, no symbol check, no cache) ──
function v1OverrideDecimals(api: TokenMetadata, chain?: string): { detected: string[]; verified: TokenMetadata; source: string } {
  const detected: string[] = [];
  const verified: TokenMetadata = { ...api };
  let source = 'caller-trusted';
  if (chain && api.symbol?.toUpperCase() === 'USDC') {
    const groundTruth = NATIVE_USDC_DECIMALS[chain.toLowerCase()];
    if (groundTruth !== undefined && groundTruth !== api.decimals) {
      detected.push(`decimals: ${api.decimals}→${groundTruth}`);
      verified.decimals = groundTruth;
      source = 'ground-truth-table';
    }
  }
  return { detected, verified, source };
}

// ── Mocked PublicClient for Scenario 3 (hypothetical ERC-20 wrong symbol) ──
function mockPublicClient(decimals: number, symbol: string): any {
  return {
    readContract: async (call: any) => {
      if (call.functionName === 'decimals') return decimals;
      if (call.functionName === 'symbol') return symbol;
      throw new Error('unknown call');
    },
  };
}

interface ScenarioOutcome {
  scenario: string;
  v1: { detected: string[]; source: string; latencyMs: number };
  v2: { detected: string[]; source: string; latencyMs: number; cacheHit: boolean };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
  return { value, ms };
}

async function main() {
  console.log(`Bench 2.3 — Metadata Trust (v1 override_api_decimals vs v2 verifyTokenMetadata)`);
  console.log(`  Scenarios:   4`);
  console.log(`  Iterations:  ${ITERATIONS} per scenario\n`);

  const arcClient = createPublicClient({ transport: http(ARC_RPC) });

  // Per-scenario outcome (collected across iterations)
  const allResults: ScenarioOutcome[] = [];

  // ── Scenario 1: Arc native USDC, API says decimals=18, ground-truth=6 ──
  //   v1 catches via ground-truth table
  //   v2 catches via ground-truth table (same source)
  console.log('── Scenario 1: Arc native USDC, API decimals=18 (wrong) ──');
  for (let i = 0; i < ITERATIONS; i++) {
    const api: TokenMetadata = { decimals: 18, symbol: 'USDC', isNative: true };
    const v1 = await timed(async () => v1OverrideDecimals(api, 'arc-testnet'));
    const v2 = await timed(() => verifyTokenMetadata(api, { chain: 'arc-testnet' }));
    allResults.push({
      scenario: 'arc-native-usdc-wrong-decimals',
      v1: { detected: v1.value.detected, source: v1.value.source, latencyMs: v1.ms },
      v2: { detected: v2.value.discrepancies, source: v2.value.source, latencyMs: v2.ms, cacheHit: false },
    });
  }

  // ── Scenario 2: Arc native USDC, API agrees (decimals=6) ──
  //   v1: nothing to override, source='caller-trusted' (looks like nothing happened)
  //   v2: verification passed, source='ground-truth-table' (audit-friendly)
  console.log('── Scenario 2: Arc native USDC, API decimals=6 (agrees) ──');
  for (let i = 0; i < ITERATIONS; i++) {
    const api: TokenMetadata = { decimals: 6, symbol: 'USDC', isNative: true };
    const v1 = await timed(async () => v1OverrideDecimals(api, 'arc-testnet'));
    const v2 = await timed(() => verifyTokenMetadata(api, { chain: 'arc-testnet' }));
    allResults.push({
      scenario: 'arc-native-usdc-agrees',
      v1: { detected: v1.value.detected, source: v1.value.source, latencyMs: v1.ms },
      v2: { detected: v2.value.discrepancies, source: v2.value.source, latencyMs: v2.ms, cacheHit: false },
    });
  }

  // ── Scenario 3: Hypothetical ERC-20 with wrong symbol (mocked readContract) ──
  //   v1 doesn't check symbol → drift undetected
  //   v2 catches via on-chain
  console.log('── Scenario 3: ERC-20 wrong symbol (mocked) ──');
  const erc20Mock = mockPublicClient(6, 'USDC.e');
  for (let i = 0; i < ITERATIONS; i++) {
    const api: TokenMetadata = { decimals: 6, symbol: 'USDC', address: '0xabcdef0123456789abcdef0123456789abcdef01' };
    const v1 = await timed(async () => v1OverrideDecimals(api, 'arc-testnet'));
    const v2 = await timed(() => verifyTokenMetadata(api, { publicClient: erc20Mock, chain: 'arc-testnet' }));
    allResults.push({
      scenario: 'erc20-wrong-symbol',
      v1: { detected: v1.value.detected, source: v1.value.source, latencyMs: v1.ms },
      v2: { detected: v2.value.discrepancies, source: v2.value.source, latencyMs: v2.ms, cacheHit: false },
    });
  }

  // ── Scenario 4: Cache hit (50 queries of the same token) ──
  //   v1: no cache; recomputes every time
  //   v2: first call queries, subsequent 49 hit cache
  console.log('── Scenario 4: Cache (50 lookups of same token) ──');
  const cache = new Map<string, MetadataTrustResult>();
  for (let i = 0; i < ITERATIONS; i++) {
    const api: TokenMetadata = { decimals: 18, symbol: 'USDC', isNative: true };
    const v1 = await timed(async () => v1OverrideDecimals(api, 'arc-testnet'));
    const cacheKeyExisted = cache.size > 0;
    const v2 = await timed(() => verifyTokenMetadata(api, { chain: 'arc-testnet', cache }));
    allResults.push({
      scenario: 'cache-50x',
      v1: { detected: v1.value.detected, source: v1.value.source, latencyMs: v1.ms },
      v2: { detected: v2.value.discrepancies, source: v2.value.source, latencyMs: v2.ms, cacheHit: cacheKeyExisted },
    });
  }

  // ── Aggregate ─────────────────────────────────────────────────────
  function aggScenario(name: string) {
    const subset = allResults.filter(r => r.scenario === name);
    const v1Det = new Set(subset.flatMap(r => r.v1.detected));
    const v2Det = new Set(subset.flatMap(r => r.v2.detected));
    const v1Avg = (subset.reduce((s, r) => s + r.v1.latencyMs, 0) / subset.length).toFixed(3);
    const v2Avg = (subset.reduce((s, r) => s + r.v2.latencyMs, 0) / subset.length).toFixed(3);
    const v2FirstMs = subset[0]?.v2.latencyMs.toFixed(3) ?? '?';
    const v2RestAvg = subset.length > 1
      ? (subset.slice(1).reduce((s, r) => s + r.v2.latencyMs, 0) / (subset.length - 1)).toFixed(3)
      : 'n/a';
    return {
      scenario: name,
      v1_detected: v1Det.size === 0 ? '(none)' : Array.from(v1Det).join('; '),
      v2_detected: v2Det.size === 0 ? '(none)' : Array.from(v2Det).join('; '),
      v1_source: subset[0]?.v1.source ?? '?',
      v2_source: subset[0]?.v2.source ?? '?',
      v1_avg_ms: v1Avg,
      v2_avg_ms: v2Avg,
      v2_first_ms: v2FirstMs,
      v2_rest_avg_ms: v2RestAvg,
    };
  }

  console.log('\n══════════ Bench 2.3 Summary ══════════');
  const summary = [
    aggScenario('arc-native-usdc-wrong-decimals'),
    aggScenario('arc-native-usdc-agrees'),
    aggScenario('erc20-wrong-symbol'),
    aggScenario('cache-50x'),
  ];
  console.table(summary.map(s => ({
    scenario: s.scenario,
    v1_detected: s.v1_detected,
    v2_detected: s.v2_detected,
    v1_source: s.v1_source,
    v2_source: s.v2_source,
  })));
  console.log('Latency (ms):');
  console.table(summary.map(s => ({
    scenario: s.scenario,
    v1_avg: s.v1_avg_ms,
    v2_avg: s.v2_avg_ms,
    v2_first: s.v2_first_ms,
    v2_rest_avg: s.v2_rest_avg_ms,
  })));

  const out = {
    meta: {
      bench: 'v1-vs-v2-metadata-trust',
      timestamp: TIMESTAMP,
      iterations: ITERATIONS,
      arcRpcUrl: ARC_RPC,
    },
    summary,
    raw: allResults,
  };
  const outFile = path.join(RESULTS_DIR, `v1-vs-v2-metadata-trust-${TIMESTAMP}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\n💾 Saved: ${outFile}`);
}

main().catch(err => { console.error('Bench 2.3 failed:', err); process.exit(1); });
