/**
 * Nanopayments Exp A: Rate Limit
 *
 * N concurrent nanopayments — when do they start failing?
 * What's the Gateway concurrency cap? Same code:5 as the Wallets API,
 * or a different shape?
 *
 * Modes:
 *   N=5, N=10, N=20 staged escalation
 *
 * Usage:
 *   npx tsx --env-file=../circle-bench/.env exp-a-rate-limit.ts
 */

import { GatewayClient } from '@circle-fin/x402-batching/client';
import * as fs from 'fs';

const BUYER_KEY = process.env.NANOPAY_BUYER_KEY as `0x${string}` | undefined;
const SELLER_URL = 'http://localhost:4021/item';
const RESULTS_DIR = '../../experiment-results';
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

interface CallResult {
  index: number;
  success: boolean;
  statusCode?: number;
  errorCode?: number | string;
  error?: string;
  latencyMs: number;
}

interface BatchResult {
  n: number;
  successes: number;
  failures: number;
  errorTypes: Record<string, number>;
  results: CallResult[];
}

async function runBatch(n: number, client: GatewayClient): Promise<BatchResult> {
  console.log(`\nTesting N=${n} concurrent nanopayments...`);

  const results: CallResult[] = await Promise.all(
    Array.from({ length: n }, async (_, i): Promise<CallResult> => {
      const start = Date.now();
      try {
        const res: any = await client.pay(SELLER_URL);
        return {
          index: i,
          success: true,
          statusCode: res?.status,
          latencyMs: Date.now() - start,
        };
      } catch (err: any) {
        return {
          index: i,
          success: false,
          error: err?.message?.slice(0, 200),
          statusCode: err?.response?.status,
          errorCode: err?.response?.data?.code,
          latencyMs: Date.now() - start,
        };
      }
    })
  );

  const successes = results.filter(r => r.success).length;
  const failures = results.filter(r => !r.success);
  const errorTypes = failures.reduce<Record<string, number>>((acc, r) => {
    const key = String(r.errorCode ?? r.statusCode ?? 'unknown');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`  Success: ${successes}/${n} (${(successes / n * 100).toFixed(0)}%)`);
  if (Object.keys(errorTypes).length > 0) {
    console.log(`  Errors:`, errorTypes);
  }

  return { n, successes, failures: n - successes, errorTypes, results };
}

async function main() {
  if (!BUYER_KEY) throw new Error('Missing NANOPAY_BUYER_KEY');

  const client = new GatewayClient({ chain: 'arcTestnet', privateKey: BUYER_KEY });

  const balances = await client.getBalances();
  console.log('Gateway available:', balances.gateway.formattedAvailable, 'USDC');

  const allResults: BatchResult[] = [];
  const ladder = [5, 10, 20, 50, 100];
  for (let idx = 0; idx < ladder.length; idx++) {
    const n = ladder[idx];
    const result = await runBatch(n, client);
    allResults.push(result);

    if (idx < ladder.length - 1) {
      console.log('  Waiting 15s before next batch...');
      await new Promise(r => setTimeout(r, 15000));
    }
  }

  console.log('\n=== SUMMARY ===');
  allResults.forEach(r => {
    console.log(`  N=${r.n}: ${r.successes}/${r.n} success`);
  });
  const firstFailure = allResults.find(r => r.failures > 0);
  if (firstFailure) {
    console.log(`\nRate limit kicks in at N=${firstFailure.n}`);
  } else {
    const maxN = allResults[allResults.length - 1]?.n ?? 0;
    console.log(`\nNo rate limit detected up to N=${maxN}. Try larger N.`);
  }

  fs.writeFileSync(
    `${RESULTS_DIR}/exp-np-a-rate-limit-${TIMESTAMP}.json`,
    JSON.stringify({ experiments: allResults }, null, 2)
  );
  console.log(`\nSaved results.`);
}

main().catch(err => { console.error('Fatal:', err?.message ?? err); process.exit(1); });
