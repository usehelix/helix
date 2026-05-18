/**
 * Nanopayments Exp C: Idempotency
 *
 * The pivotal question: can the same EIP-3009 signature be submitted twice?
 *
 * Scenario:
 *   Agent sends nanopayment → network timeout → agent retries.
 *   If Gateway accepts a replay → double-charge.
 *   If Gateway rejects → what shape is the error? Can the agent
 *   distinguish "already settled" from "payment failed"?
 *
 * Method:
 *   1. Make one normal payment, intercepting the Payment-Signature header
 *   2. Manually re-submit the same signature
 *
 * Usage:
 *   npx tsx --env-file=../circle-bench/.env exp-c-idempotency.ts
 */

import { GatewayClient } from '@circle-fin/x402-batching/client';
import * as fs from 'fs';

const BUYER_KEY = process.env.NANOPAY_BUYER_KEY as `0x${string}` | undefined;
const SELLER_URL = 'http://localhost:4021/item';
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function main() {
  if (!BUYER_KEY) throw new Error('Missing NANOPAY_BUYER_KEY');

  console.log('Exp C: Idempotency Test\n');
  console.log('Step 1: Intercepting payment signature from first call...');

  let capturedSignature: string | null = null;
  const originalFetch = global.fetch;

  global.fetch = (async (input: any, init?: any) => {
    const headers = init?.headers ?? {};
    const sig = headers['Payment-Signature'] ?? headers['payment-signature'] ?? headers.get?.('Payment-Signature');
    if (sig && !capturedSignature) {
      capturedSignature = sig;
      console.log('  Captured Payment-Signature:', String(sig).slice(0, 50) + '...');
    }
    return originalFetch(input, init);
  }) as typeof global.fetch;

  const client = new GatewayClient({ chain: 'arcTestnet', privateKey: BUYER_KEY });

  const firstResult = { attempt: 1, success: false, statusCode: 0, body: '' };

  try {
    const res: any = await client.pay(SELLER_URL);
    firstResult.success = true;
    firstResult.statusCode = res?.status ?? 200;
    firstResult.body = JSON.stringify(res?.data ?? {});
    console.log('  First payment: SUCCESS');
  } catch (err: any) {
    firstResult.statusCode = err?.response?.status ?? 0;
    firstResult.body = JSON.stringify(err?.response?.data ?? err?.message ?? {});
    console.log('  First payment: FAILED -', err?.message);
  }

  global.fetch = originalFetch;

  if (!capturedSignature) {
    console.log('\n⚠️  Could not capture signature. GatewayClient may use undici or non-global fetch.');
    console.log('   Falling back: documenting attempted approach only.');
  }

  console.log('\nStep 2: Replaying same signature...');

  const secondResult = { attempt: 2, success: false, statusCode: 0, body: '', error: '' };

  if (capturedSignature) {
    try {
      const res = await fetch(SELLER_URL, {
        headers: {
          'Payment-Signature': capturedSignature,
          'X-Payment-Replay': 'true',
        },
      });
      secondResult.success = res.ok;
      secondResult.statusCode = res.status;
      secondResult.body = await res.text();

      if (res.ok) {
        console.log('  ⚠️  REPLAYED PAYMENT ACCEPTED! Double-spend possible!');
        console.log('  Status:', res.status);
        console.log('  Body:', secondResult.body.slice(0, 200));
      } else {
        console.log('  ✅ Replayed payment rejected (expected behavior)');
        console.log('  Status:', res.status);
        console.log('  Body:', secondResult.body.slice(0, 200));
      }
    } catch (err: any) {
      secondResult.error = err?.message;
      console.log('  Error:', err?.message);
    }
  } else {
    secondResult.error = 'signature_not_captured';
  }

  console.log('\n=== FINDINGS ===');
  if (secondResult.success) {
    console.log('⚠️  CRITICAL: Same EIP-3009 signature accepted twice');
    console.log('   Agents can be double-charged on retry.');
    console.log('   Gene Capsule: gateway-idempotency-missing → content_hash_dedup');
  } else if (capturedSignature) {
    console.log('✅ Gateway correctly rejects replayed signatures');
    console.log('   HTTP status:', secondResult.statusCode);
    console.log('   Agent now needs to distinguish "already settled" vs "payment failed"');
  } else {
    console.log('(inconclusive — signature interception failed)');
  }

  fs.writeFileSync(
    `../../experiment-results/exp-np-c-idempotency-${TIMESTAMP}.json`,
    JSON.stringify({
      firstResult,
      secondResult,
      capturedSignaturePrefix: capturedSignature ? String(capturedSignature).slice(0, 50) : null,
    }, null, 2)
  );
  console.log('\nSaved results.');
}

main().catch(err => { console.error('Fatal:', err?.message ?? err); process.exit(1); });
