/**
 * Nanopayments Exp B: Balance Exhaustion
 *
 * Drain the Gateway balance and observe what error the agent sees.
 * Question: can an agent programmatically distinguish "balance_exhausted"
 * from other failure modes (rate limit, network, etc)?
 *
 * Usage:
 *   npx tsx --env-file=../circle-bench/.env exp-b-balance-exhaustion.ts
 */

import { GatewayClient } from '@circle-fin/x402-batching/client';
import * as fs from 'fs';

const BUYER_KEY = process.env.NANOPAY_BUYER_KEY as `0x${string}` | undefined;
const SELLER_URL = 'http://localhost:4021/item';
const PRICE_PER_CALL = 0.001;
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

interface CallResult {
  call: number;
  success: boolean;
  latencyMs: number;
  statusCode?: number;
  errorCode?: number | string;
  errorMessage?: string;
  rawError?: string;
}

async function main() {
  if (!BUYER_KEY) throw new Error('Missing NANOPAY_BUYER_KEY');

  const client = new GatewayClient({ chain: 'arcTestnet', privateKey: BUYER_KEY });

  const balances = await client.getBalances();
  const available = parseFloat(balances.gateway.formattedAvailable ?? '0');
  console.log('Starting Gateway balance:', available, 'USDC');

  const callsToExhaust = Math.ceil(available / PRICE_PER_CALL) + 5;
  console.log(`Will attempt ${callsToExhaust} calls to exhaust balance...`);

  const results: CallResult[] = [];
  let consecutiveFailures = 0;

  for (let i = 0; i < callsToExhaust; i++) {
    const start = Date.now();
    try {
      await client.pay(SELLER_URL);
      results.push({ call: i, success: true, latencyMs: Date.now() - start });
      consecutiveFailures = 0;

      if (i % 10 === 0) {
        const bal = await client.getBalances();
        console.log(`  Call ${i}: success. Balance: ${bal.gateway.formattedAvailable} USDC`);
      }
    } catch (err: any) {
      const info: CallResult = {
        call: i,
        success: false,
        statusCode: err?.response?.status,
        errorCode: err?.response?.data?.code,
        errorMessage: err?.response?.data?.message ?? err?.message,
        rawError: JSON.stringify(err?.response?.data ?? err?.message ?? {}).slice(0, 300),
        latencyMs: Date.now() - start,
      };
      results.push(info);
      consecutiveFailures++;

      if (consecutiveFailures === 1) {
        console.log(`\n⚠️  First failure at call ${i}:`);
        console.log('  Status:', info.statusCode);
        console.log('  Code:', info.errorCode);
        console.log('  Message:', info.errorMessage);
        console.log('  Raw:', info.rawError);
      }

      if (consecutiveFailures >= 3) {
        console.log(`\nStopping after ${consecutiveFailures} consecutive failures.`);
        break;
      }
    }
  }

  const successes = results.filter(r => r.success).length;
  const failures = results.filter(r => !r.success);

  console.log('\n=== SUMMARY ===');
  console.log(`Total calls: ${results.length}`);
  console.log(`Successes: ${successes}`);
  console.log(`Failures: ${failures.length}`);

  if (failures.length > 0) {
    const firstFail = failures[0];
    console.log('\nFirst failure error:');
    console.log(`  HTTP status: ${firstFail.statusCode}`);
    console.log(`  Code: ${firstFail.errorCode}`);
    console.log(`  Message: ${firstFail.errorMessage}`);
    console.log('\nKey question: is this error distinct from rate-limit?');
    console.log('Can an agent programmatically detect "balance_exhausted" vs "rate_limited"?');
  }

  fs.writeFileSync(
    `../../experiment-results/exp-np-b-balance-exhaustion-${TIMESTAMP}.json`,
    JSON.stringify({ successes, failures: failures.length, firstFailure: failures[0], results }, null, 2)
  );
  console.log('\nSaved results.');
}

main().catch(err => { console.error('Fatal:', err?.message ?? err); process.exit(1); });
