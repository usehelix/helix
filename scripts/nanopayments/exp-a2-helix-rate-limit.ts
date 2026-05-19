/**
 * Nanopayments Exp A2: Helix Rate Limit A/B
 *
 * Compare bare vs helix at Gateway's high-concurrency knee.
 *
 * Bare:  N=50 concurrent → ~96% (4% fail in Exp A)
 * Helix: serialize + backoff → target 100%
 *
 * Usage:
 *   npx tsx --env-file=../circle-bench/.env exp-a2-helix-rate-limit.ts
 */

import { GatewayClient } from '@circle-fin/x402-batching/client';
import * as fs from 'fs';

const BUYER_KEY = process.env.NANOPAY_BUYER_KEY as `0x${string}` | undefined;
const SELLER_URL = 'http://localhost:4021/item';
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Third strategy attempt — see prior two NEGATIVE result JSONs for context.
//
// Run 1 (naive params): Helix serialize_and_backoff with 500ms init backoff.
//   Result: 62% (lost 18 tx). Wallets-style params don't fit Gateway.
//
// Run 2 (calibrated serialize): same strategy, 5s init / 32s max backoff,
//   60s pre-wait. Result: 97% (still lost 1 tx). Strategy DIRECTION is wrong:
//   serialize_and_backoff fights Gateway's throughput throttle, which penalizes
//   sustained sequential traffic. Wallets API has a concurrency lock;
//   Gateway has a sliding-window throughput throttle. Opposite shape.
//
// Run 3 (this script — burst_then_pace): exploit Gateway's batch settlement
//   window. Fire N concurrent in a small batch, wait for throttle to release,
//   fire next batch. This is the OPPOSITE of the Wallets strategy.
//
// Different failure_code, different strategy. NOT the same Gene Capsule.
const N = 100;
const BATCH_SIZE = 10;
const BATCH_PAUSE_MS = 20000; // 20s between batches
const PRE_WAIT_MS = 60000;    // 60s pre-wait to clear residual throttle from bare's N=100 burst

interface CallResult {
  i: number;
  success: boolean;
  attempts?: number;
  error?: string;
  latencyMs?: number;
}

async function runBare(client: GatewayClient) {
  console.log(`\n[BARE] N=${N} concurrent nanopayments...`);
  const start = Date.now();

  const results: CallResult[] = await Promise.all(
    Array.from({ length: N }, async (_, i): Promise<CallResult> => {
      try {
        await client.pay(SELLER_URL);
        return { i, success: true, latencyMs: Date.now() - start };
      } catch (err: any) {
        return {
          i,
          success: false,
          error: err?.message?.slice(0, 80),
          latencyMs: Date.now() - start,
        };
      }
    })
  );

  const successes = results.filter(r => r.success).length;
  console.log(`[BARE] Result: ${successes}/${N} (${(successes / N * 100).toFixed(0)}%)`);
  return { mode: 'bare', n: N, successes, results };
}

async function runHelixBurstThenPace(client: GatewayClient) {
  console.log(`\n[HELIX] N=${N} with burst_then_pace strategy...`);
  console.log(`[HELIX] Strategy: fire batches of ${BATCH_SIZE} concurrent → wait ${BATCH_PAUSE_MS / 1000}s → repeat`);

  const results: CallResult[] = [];
  let successes = 0;
  const totalBatches = Math.ceil(N / BATCH_SIZE);

  for (let batch = 0; batch < totalBatches; batch++) {
    const start = batch * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, N);
    const batchSize = end - start;

    console.log(`\n  [helix] Batch ${batch + 1}/${totalBatches}: firing ${batchSize} concurrent...`);

    const batchResults: CallResult[] = await Promise.all(
      Array.from({ length: batchSize }, async (_, i): Promise<CallResult> => {
        const tStart = Date.now();
        try {
          await client.pay(SELLER_URL);
          return { i: start + i, success: true, latencyMs: Date.now() - tStart };
        } catch (err: any) {
          return {
            i: start + i,
            success: false,
            error: err?.message?.slice(0, 80),
            latencyMs: Date.now() - tStart,
          };
        }
      })
    );

    const batchSuccess = batchResults.filter(r => r.success).length;
    successes += batchSuccess;
    results.push(...batchResults);
    console.log(`  [helix] Batch ${batch + 1}: ${batchSuccess}/${batchSize} success`);

    if (end < N) {
      console.log(`  [helix] Waiting ${BATCH_PAUSE_MS / 1000}s before next batch...`);
      await sleep(BATCH_PAUSE_MS);
    }
  }

  console.log(`\n[HELIX] Total: ${successes}/${N} (${(successes / N * 100).toFixed(0)}%)`);
  return { mode: 'helix_burst_then_pace', n: N, successes, results };
}

async function main() {
  if (!BUYER_KEY) throw new Error('Missing NANOPAY_BUYER_KEY');

  const client = new GatewayClient({ chain: 'arcTestnet', privateKey: BUYER_KEY });

  const balances = await client.getBalances();
  console.log('Gateway balance:', balances.gateway.formattedAvailable, 'USDC');

  const bareResult = await runBare(client);

  console.log(`\nWaiting ${PRE_WAIT_MS / 1000}s for Gateway throttle to clear residual from bare...`);
  await sleep(PRE_WAIT_MS);

  const helixResult = await runHelixBurstThenPace(client);

  const bareRate = (bareResult.successes / N * 100).toFixed(0);
  const helixRate = (helixResult.successes / N * 100).toFixed(0);
  const delta = helixResult.successes - bareResult.successes;

  console.log('\n' + '='.repeat(50));
  console.log(`A/B COMPARISON — N=${N} Gateway payments`);
  console.log('='.repeat(50));
  console.log(`  Bare:  ${bareRate}% (${bareResult.successes}/${N})`);
  console.log(`  Helix: ${helixRate}% (${helixResult.successes}/${N})  [strategy: burst_then_pace]`);
  console.log(`  Delta: ${delta >= 0 ? '+' : ''}${delta} transactions recovered`);
  console.log('='.repeat(50));

  fs.writeFileSync(
    `../../experiment-results/exp-np-a2-helix-rate-limit-${TIMESTAMP}.json`,
    JSON.stringify({ bare: bareResult, helix: helixResult }, null, 2)
  );
  console.log('\nSaved.');
}

main().catch(err => { console.error('Fatal:', err?.message ?? err); process.exit(1); });
