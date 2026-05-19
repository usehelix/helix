/**
 * Nanopayments Exp C2: Helix Error Intercept A/B
 *
 * Both arms call client.pay() with an injected already-used signature.
 *
 * Bare arm:  catches the SDK's flattened "Payment processing error" only.
 * Helix arm: installs a fetch interceptor BEFORE client.pay(); when the SDK
 *            throws the same opaque error, Helix has already captured the
 *            raw facilitator reason from the wire.
 *
 * The key moment: both arms throw the same opaque message, but Helix
 * additionally shows the raw reason it captured pre-throw.
 *
 * Usage:
 *   npx tsx --env-file=../circle-bench/.env exp-c2-helix-error-intercept.ts
 */

import { GatewayClient } from '@circle-fin/x402-batching/client';
import * as fs from 'fs';

const BUYER_KEY = process.env.NANOPAY_BUYER_KEY as `0x${string}` | undefined;
const SELLER_URL = 'http://localhost:4021/item';
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function demoBareBehavior(client: GatewayClient, capturedSig: string): Promise<{ thrownMessage: string | null }> {
  console.log('\n[BARE] Calling client.pay() after nonce is already used...');

  let thrownMessage: string | null = null;
  const orig = global.fetch;

  // Inject the already-used signature so client.pay() submits a replay
  global.fetch = (async (input: any, init?: any) => {
    if (init?.headers?.['Payment-Signature']) {
      init.headers['Payment-Signature'] = capturedSig;
    }
    return orig(input, init);
  }) as typeof global.fetch;

  try {
    await client.pay(SELLER_URL);
    console.log('[BARE] Unexpected success');
  } catch (err: any) {
    thrownMessage = err?.message ?? String(err);
    console.log(`[BARE] client.pay() threw: "${thrownMessage}"`);
    console.log('[BARE] Agent sees: OPAQUE — cannot classify');
    console.log('[BARE] Agent decision: unknown — retry? give up? wait?');
  } finally {
    global.fetch = orig;
  }

  return { thrownMessage };
}

async function demoHelixBehavior(client: GatewayClient, capturedSig: string): Promise<{ thrownMessage: string | null; interceptedReason: string | null; interceptedStatus: number | null }> {
  console.log('\n[HELIX] Same scenario, but with Helix fetch interceptor...');

  let thrownMessage: string | null = null;
  let interceptedReason: string | null = null;
  let interceptedStatus: number | null = null;
  const orig = global.fetch;

  // Helix intercepts request to inject the used sig AND captures the raw response
  global.fetch = (async (input: any, init?: any) => {
    if (init?.headers?.['Payment-Signature']) {
      init.headers['Payment-Signature'] = capturedSig;
    }
    const res = await orig(input, init);
    if (!res.ok) {
      try {
        const body = await res.clone().json();
        interceptedReason = body?.reason ?? body?.error ?? null;
        interceptedStatus = res.status;
      } catch {}
    }
    return res;
  }) as typeof global.fetch;

  try {
    await client.pay(SELLER_URL);
  } catch (err: any) {
    thrownMessage = err?.message ?? String(err);
    const reasonStr: string = String(interceptedReason ?? '');
    console.log(`[HELIX] client.pay() threw: "${thrownMessage}" (same opaque error)`);
    console.log(`[HELIX] But intercepted reason: "${reasonStr || '(none)'}"`);
    console.log(`[HELIX] Intercepted status: ${interceptedStatus}`);

    if (reasonStr === 'nonce_already_used') {
      console.log('[HELIX] Classification: ALREADY_SETTLED');
      console.log('[HELIX] Decision: DO NOT retry — payment was processed');
      console.log('[HELIX] Gene Map: recording nonce_already_used pattern');
    } else if (reasonStr.includes('rate')) {
      console.log('[HELIX] Classification: RATE_LIMITED');
      console.log('[HELIX] Decision: backoff and retry');
    } else if (reasonStr.includes('balance') || reasonStr.includes('insufficient')) {
      console.log('[HELIX] Classification: INSUFFICIENT_BALANCE');
      console.log('[HELIX] Decision: top up Gateway balance');
    } else {
      console.log('[HELIX] Classification: UNKNOWN — fallback to latency-based inference');
    }
  } finally {
    global.fetch = orig;
  }

  return { thrownMessage, interceptedReason, interceptedStatus };
}

async function main() {
  if (!BUYER_KEY) throw new Error('Missing NANOPAY_BUYER_KEY');

  const client = new GatewayClient({ chain: 'arcTestnet', privateKey: BUYER_KEY });

  console.log('Step 1: Making initial payment to capture signature...');
  let capturedSig: string | null = null;
  const orig = global.fetch;
  global.fetch = (async (input: any, init?: any) => {
    const sig = init?.headers?.['Payment-Signature'];
    if (sig && !capturedSig) {
      capturedSig = sig;
    }
    return orig(input, init);
  }) as typeof global.fetch;

  try { await client.pay(SELLER_URL); } catch {}
  global.fetch = orig;

  if (!capturedSig) {
    console.log('Could not capture signature. Exiting.');
    return;
  }
  console.log('✓ Signature captured');

  const bareOutcome = await demoBareBehavior(client, capturedSig);
  const helixOutcome = await demoHelixBehavior(client, capturedSig);

  console.log('\n' + '='.repeat(60));
  console.log('A/B COMPARISON — Same scenario, both arms call client.pay()');
  console.log('='.repeat(60));
  console.log(`  Bare  thrown:        "${bareOutcome.thrownMessage}"`);
  console.log(`  Helix thrown:        "${helixOutcome.thrownMessage}"`);
  console.log(`  Helix intercepted:   "${helixOutcome.interceptedReason}"  ← Helix's edge`);
  console.log('');
  console.log('  Bare agent: only sees the SDK\'s opaque message → cannot classify');
  console.log('  Helix agent: has both — uses intercepted reason to classify pre-throw');
  console.log('='.repeat(60));

  fs.writeFileSync(
    `../../experiment-results/exp-np-c2-helix-error-intercept-${TIMESTAMP}.json`,
    JSON.stringify({
      capturedSigPrefix: String(capturedSig).slice(0, 50),
      bare: bareOutcome,
      helix: helixOutcome,
      finding: 'Both arms throw the same opaque SDK error from client.pay(). Helix\'s fetch interceptor captures the raw facilitator reason that the SDK strips.',
    }, null, 2)
  );
  console.log('\nSaved.');
}

main().catch(err => { console.error('Fatal:', err?.message ?? err); process.exit(1); });
