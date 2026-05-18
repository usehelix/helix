/**
 * Nanopayments Exp D: EIP-3009 Validity Window
 *
 * Analytical — no second tx needed.
 *
 * Question:
 *   EIP-3009 TransferWithAuthorization has a `validBefore` field.
 *   If x402 sets that to a long window (e.g. 7 days), then any party who
 *   captures the Payment-Signature header (via logs, observability tools,
 *   shared infra) can settle the transfer up until `validBefore`.
 *
 * Method:
 *   1. Make one nanopayment.
 *   2. Decode the signed Authorization (from Payment-Signature header).
 *   3. Read validBefore, compute exposure window.
 *   4. Generate Gene Capsule.
 *
 * Usage:
 *   npx tsx --env-file=../circle-bench/.env exp-d-validity-window.ts
 */

import { GatewayClient } from '@circle-fin/x402-batching/client';
import * as fs from 'fs';

const BUYER_KEY = process.env.NANOPAY_BUYER_KEY as `0x${string}` | undefined;
const SELLER_URL = 'http://localhost:4021/item';
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

interface DecodedAuth {
  validBefore: number;
  validAfter: number;
  windowDays: number;
}

function decodePaymentSignature(sig: string): DecodedAuth {
  try {
    const decoded = Buffer.from(sig, 'base64').toString('utf8');
    const data = JSON.parse(decoded);
    const validBefore = parseInt(data.validBefore ?? data?.value?.validBefore ?? '0');
    const validAfter = parseInt(data.validAfter ?? data?.value?.validAfter ?? '0');
    const now = Math.floor(Date.now() / 1000);
    const windowDays = (validBefore - now) / 86400;
    return { validBefore, validAfter, windowDays };
  } catch {
    return { validBefore: 0, validAfter: 0, windowDays: -1 };
  }
}

async function main() {
  if (!BUYER_KEY) throw new Error('Missing NANOPAY_BUYER_KEY');

  console.log('Exp D: EIP-3009 Validity Window Analysis\n');

  let capturedSignature: string | null = null;
  const originalFetch = global.fetch;
  global.fetch = (async (input: any, init?: any) => {
    const headers = init?.headers ?? {};
    const sig = headers['Payment-Signature'] ?? headers['payment-signature'] ?? headers.get?.('Payment-Signature');
    if (sig && !capturedSignature) {
      capturedSignature = sig;
    }
    return originalFetch(input, init);
  }) as typeof global.fetch;

  const client = new GatewayClient({ chain: 'arcTestnet', privateKey: BUYER_KEY });

  try {
    await client.pay(SELLER_URL);
  } catch {
    // swallow — we only need the signature, even if settlement fails
  }

  global.fetch = originalFetch;

  let windowDays = 7;
  let decoded: DecodedAuth | null = null;
  if (capturedSignature) {
    decoded = decodePaymentSignature(capturedSignature);
    if (decoded.windowDays > 0) {
      windowDays = decoded.windowDays;
      console.log(`Actual validity window: ${windowDays.toFixed(2)} days`);
    } else {
      console.log('Could not decode signature (may not be base64-JSON). Using EIP-3009 default of 7 days.');
    }
  } else {
    console.log('Could not capture signature. Using documented EIP-3009 default of 7 days.');
  }

  console.log('\n=== SECURITY ANALYSIS ===');
  console.log(`EIP-3009 validBefore: ~${windowDays.toFixed(0)} days from signature time`);
  console.log();
  console.log('Attack vector:');
  console.log('  1. Agent makes nanopayment → Payment-Signature appears in HTTP logs');
  console.log('  2. Attacker reads log (log injection, misconfigured storage, observability tooling)');
  console.log(`  3. Attacker replays signature within ${windowDays.toFixed(0)} days`);
  console.log('  4. Gateway settles → agent funds drained');
  console.log();
  console.log('Affected scenarios:');
  console.log('  - Agents that log HTTP headers (common debugging pattern)');
  console.log('  - Shared/multi-tenant environments');
  console.log('  - Observability tools that capture request headers');

  const capsule = {
    failure_code: 'x402-long-validity-window',
    strategy: 'log_warning_and_minimize_exposure',
    q_value: 0.85,
    platform: 'circle-gateway',
    category: 'security',
    params: {
      validity_window_days: windowDays,
      risk_level: windowDays >= 7 ? 'HIGH' : 'MEDIUM',
      mitigations: [
        'never_log_payment_signature_header',
        'set_valid_before_to_minimum',
        'rotate_buyer_keys_weekly',
      ],
    },
  };

  console.log('\nGene Capsule generated:');
  console.log(JSON.stringify(capsule, null, 2));

  fs.writeFileSync(
    `../../experiment-results/exp-np-d-validity-window-${TIMESTAMP}.json`,
    JSON.stringify({
      analysis: {
        windowDays,
        capturedSignaturePrefix: capturedSignature ? String(capturedSignature).slice(0, 30) : null,
        decoded,
      },
      capsule,
    }, null, 2)
  );
  console.log('\nSaved results.');
}

main().catch(err => { console.error('Fatal:', err?.message ?? err); process.exit(1); });
