/**
 * scripts/circle-bench/v1-vs-v2-rate-limit.ts
 *
 * Bench 2.1 — wallets-api-rate-limit
 *   V1 arm: Helix wrap() with the seeded serialize_and_backoff capsule (q=0.95)
 *   V2 arm: chunkConcurrent() called directly, no Helix wrap
 *
 *   5 trials per arm, 10 concurrent USDC transfers per trial (0.0001 USDC each).
 *   Real Circle Sandbox + Arc Testnet calls. Run from circle-bench/ env.
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { wrap } from '../../packages/core/dist/index.js';
import { chunkConcurrent } from '../../packages/core/dist/strategies/circle-v2/chunk-concurrent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const TRIALS = parseInt(process.env.BENCH_TRIALS ?? '5', 10);
const TRANSFERS_PER_TRIAL = parseInt(process.env.BENCH_TRANSFERS ?? '10', 10);
const AMOUNT_USDC = process.env.BENCH_AMOUNT ?? '0.0001';
const COOLDOWN_MS = parseInt(process.env.BENCH_COOLDOWN_MS ?? '5000', 10);
const GENE_DB = path.join(RESULTS_DIR, `bench-rate-limit-${TIMESTAMP}.db`);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing ${name}`); process.exit(1); }
  return v;
}

interface TrialResult {
  arm: 'v1' | 'v2';
  trial: number;
  totalMs: number;
  successCount: number;
  failureCount: number;
  rl429s: number;
}

function countRateLimit(reason: unknown): boolean {
  const msg = String((reason as { message?: string })?.message ?? reason ?? '');
  return /429|rate.?limit|code.*5/i.test(msg);
}

async function main() {
  const apiKey = requireEnv('CIRCLE_API_KEY');
  const entitySecret = requireEnv('CIRCLE_ENTITY_SECRET');
  const walletId = requireEnv('CIRCLE_WALLET_ID');
  const destinationAddress = requireEnv('CIRCLE_SECOND_WALLET_ADDRESS');

  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  // Resolve USDC tokenId at runtime
  const balRes = await client.getWalletTokenBalance({ id: walletId });
  const usdc = balRes.data?.tokenBalances?.find((b: any) => b.token?.symbol === 'USDC');
  const tokenId = (usdc?.token as any)?.id;
  const balance = parseFloat(usdc?.amount ?? '0');
  if (!tokenId) { console.error('Could not resolve USDC tokenId'); process.exit(1); }

  const totalNeededUsdc = parseFloat(AMOUNT_USDC) * TRIALS * 2 * TRANSFERS_PER_TRIAL;
  console.log(`Bench 2.1 — Rate Limit (v1 serialize_and_backoff vs v2 chunk_concurrent)`);
  console.log(`  Wallet balance:  ${balance} USDC`);
  console.log(`  USDC needed:     ~${totalNeededUsdc.toFixed(4)} USDC (5 trials × 2 arms × 10 transfers × ${AMOUNT_USDC})`);
  console.log(`  Cooldown:        ${COOLDOWN_MS}ms between trials\n`);

  if (balance < totalNeededUsdc) {
    console.error(`Insufficient USDC. Have ${balance}, need ${totalNeededUsdc}.`);
    process.exit(1);
  }

  // ── single-call business function (returned tx id) ────────────────
  async function sendUsdc(amount: string): Promise<{ id: string; state: string }> {
    const resp = await client.createTransaction({
      walletId, tokenId, destinationAddress,
      amount: [amount],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    } as any);
    return { id: resp.data?.id ?? '', state: resp.data?.state ?? 'UNKNOWN' };
  }

  // ── V1 arm — wrap() + serialize_and_backoff seed capsule ──────────
  const safeSend = wrap(sendUsdc, {
    mode: 'auto',
    agentId: 'bench-v1-rl',
    geneMapPath: GENE_DB,
    context: { platform: 'circle', apiLayer: 'wallets-api' },
  });

  async function runV1Trial(trial: number): Promise<TrialResult> {
    const start = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: TRANSFERS_PER_TRIAL }, () => safeSend(AMOUNT_USDC)),
    );
    const totalMs = Date.now() - start;
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const rl429s = results.filter(r => r.status === 'rejected' && countRateLimit(r.reason)).length;
    return { arm: 'v1', trial, totalMs, successCount, failureCount: TRANSFERS_PER_TRIAL - successCount, rl429s };
  }

  // ── V2 arm — chunkConcurrent() direct ─────────────────────────────
  async function runV2Trial(trial: number): Promise<TrialResult> {
    const ops = Array.from({ length: TRANSFERS_PER_TRIAL }, () => () => sendUsdc(AMOUNT_USDC));
    const { results, stats } = await chunkConcurrent(ops, {
      chunkSize: 4, interChunkPauseMs: 1500, adaptive: true,
    });
    const rl429s = results.filter(r => r.status === 'rejected' && countRateLimit(r.reason)).length;
    return {
      arm: 'v2', trial,
      totalMs: stats.totalMs,
      successCount: stats.successes,
      failureCount: stats.failures,
      rl429s,
    };
  }

  // ── Run trials ────────────────────────────────────────────────────
  const v1Trials: TrialResult[] = [];
  console.log('── V1 trials (Helix serialize_and_backoff) ──');
  for (let i = 1; i <= TRIALS; i++) {
    const r = await runV1Trial(i);
    v1Trials.push(r);
    console.log(`  trial ${i}: ${r.totalMs}ms · ok=${r.successCount}/${TRANSFERS_PER_TRIAL} · 429s=${r.rl429s}`);
    if (i < TRIALS) await sleep(COOLDOWN_MS);
  }

  await sleep(COOLDOWN_MS * 2);
  console.log('\n── V2 trials (chunk_concurrent, size=4, pause=1500ms, adaptive) ──');
  const v2Trials: TrialResult[] = [];
  for (let i = 1; i <= TRIALS; i++) {
    const r = await runV2Trial(i);
    v2Trials.push(r);
    console.log(`  trial ${i}: ${r.totalMs}ms · ok=${r.successCount}/${TRANSFERS_PER_TRIAL} · 429s=${r.rl429s}`);
    if (i < TRIALS) await sleep(COOLDOWN_MS);
  }

  // ── Aggregate ─────────────────────────────────────────────────────
  function agg(arm: string, trials: TrialResult[]) {
    const avgMs = Math.round(trials.reduce((s, t) => s + t.totalMs, 0) / trials.length);
    const totalSuccess = trials.reduce((s, t) => s + t.successCount, 0);
    const totalFail = trials.reduce((s, t) => s + t.failureCount, 0);
    const total429 = trials.reduce((s, t) => s + t.rl429s, 0);
    const successRate = (100 * totalSuccess / (totalSuccess + totalFail)).toFixed(1);
    const throughput = ((totalSuccess / trials.length) / (avgMs / 1000)).toFixed(2);
    return {
      arm,
      avg_ms: avgMs,
      success_rate: successRate + '%',
      throughput: throughput + ' tx/s',
      total_429s: total429,
    };
  }

  console.log('\n══════════ Bench 2.1 Summary ══════════');
  const summary = [
    agg('v1 serialize_and_backoff', v1Trials),
    agg('v2 chunk_concurrent',       v2Trials),
  ];
  console.table(summary);

  const out = {
    meta: {
      bench: 'v1-vs-v2-rate-limit',
      timestamp: TIMESTAMP,
      env: { trials: TRIALS, transfersPerTrial: TRANSFERS_PER_TRIAL, amountUsdc: AMOUNT_USDC, cooldownMs: COOLDOWN_MS },
      wallet: walletId,
      tokenId,
      destination: destinationAddress,
      v2Params: { chunkSize: 4, interChunkPauseMs: 1500, adaptive: true },
    },
    v1Trials, v2Trials,
    summary,
  };
  const outFile = path.join(RESULTS_DIR, `v1-vs-v2-rate-limit-${TIMESTAMP}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\n💾 Saved: ${outFile}`);
}

main().catch(err => { console.error('Bench 2.1 failed:', err); process.exit(1); });
