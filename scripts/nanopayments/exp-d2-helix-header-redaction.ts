/**
 * Nanopayments Exp D2: Helix Header Redaction A/B
 *
 * Bare:  Payment-Signature appears in log (7-day replay window)
 * Helix: auto-redact, log never sees the signature
 *
 * Demo:
 *   Bare agent log:  "headers: {Payment-Signature: eyJ4NDAy...}"
 *   Helix agent log: "headers: {Payment-Signature: [REDACTED]}"
 *
 * Usage:
 *   npx tsx --env-file=../circle-bench/.env exp-d2-helix-header-redaction.ts
 */

import { GatewayClient } from '@circle-fin/x402-batching/client';
import * as fs from 'fs';

const BUYER_KEY = process.env.NANOPAY_BUYER_KEY as `0x${string}` | undefined;
const SELLER_URL = 'http://localhost:4021/item';
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const agentLog: string[] = [];
function agentLogger(msg: string) {
  agentLog.push(`[${new Date().toISOString()}] ${msg}`);
  console.log(msg);
}

async function runBareAgent(client: GatewayClient) {
  console.log('\n[BARE] Making payment with default logging...\n');

  const orig = global.fetch;
  global.fetch = (async (input: any, init?: any) => {
    agentLogger(`[BARE] HTTP Request to: ${input}`);
    agentLogger(`[BARE] Headers: ${JSON.stringify(init?.headers ?? {})}`);
    return orig(input, init);
  }) as typeof global.fetch;

  try { await client.pay(SELLER_URL); } catch {}
  global.fetch = orig;

  const sigInLog = agentLog.some(l => l.includes('Payment-Signature') && !l.includes('REDACTED'));
  console.log(`\n[BARE] Payment-Signature in log: ${sigInLog ? '⚠️  YES (security risk)' : '✅ No'}`);
  return { sigExposed: sigInLog };
}

function installHelixRedaction() {
  const orig = global.fetch;
  const SENSITIVE = ['Payment-Signature', 'X-Payment-Authorization', 'X-Payment-Token'];
  global.fetch = (async (input: any, init?: any) => {
    if (init?.headers) {
      const safeHeaders: Record<string, string> = { ...(init.headers as Record<string, string>) };
      SENSITIVE.forEach(h => {
        if (safeHeaders[h]) safeHeaders[h] = '[REDACTED-BY-HELIX]';
      });
      agentLogger(`[HELIX] HTTP Request to: ${input}`);
      agentLogger(`[HELIX] Headers (safe): ${JSON.stringify(safeHeaders)}`);
    }
    return orig(input, init);
  }) as typeof global.fetch;
  return () => { global.fetch = orig; };
}

async function runHelixAgent(client: GatewayClient) {
  console.log('\n[HELIX] Making payment with header redaction...\n');

  const uninstall = installHelixRedaction();
  try { await client.pay(SELLER_URL); } catch {}
  uninstall();

  const sigInLog = agentLog.some(l =>
    l.includes('[HELIX]') &&
    l.includes('Payment-Signature') &&
    !l.includes('REDACTED')
  );
  console.log(`\n[HELIX] Payment-Signature in log: ${sigInLog ? '⚠️  YES' : '✅ No (redacted)'}`);
  return { sigExposed: sigInLog };
}

async function main() {
  if (!BUYER_KEY) throw new Error('Missing NANOPAY_BUYER_KEY');

  const client = new GatewayClient({ chain: 'arcTestnet', privateKey: BUYER_KEY });

  const bareResult = await runBareAgent(client);
  const helixResult = await runHelixAgent(client);

  console.log('\n' + '='.repeat(55));
  console.log('A/B COMPARISON — Payment-Signature Log Exposure');
  console.log('='.repeat(55));
  console.log(`  Bare:  Signature in log = ${bareResult.sigExposed ? '⚠️  EXPOSED (7-day replay risk)' : '✅ Not exposed'}`);
  console.log(`  Helix: Signature in log = ${helixResult.sigExposed ? '⚠️  EXPOSED' : '✅ REDACTED (safe)'}`);
  console.log('');
  console.log('  Without Helix: any log aggregation tool (Datadog,');
  console.log('  Splunk, CloudWatch) captures 7-day replay tokens.');
  console.log('  With Helix: [REDACTED-BY-HELIX] in all log outputs.');
  console.log('='.repeat(55));

  fs.writeFileSync(
    `../../experiment-results/exp-np-d2-helix-header-redaction-${TIMESTAMP}.json`,
    JSON.stringify({ bareResult, helixResult, log: agentLog }, null, 2)
  );
  console.log('\nSaved.');
}

main().catch(err => { console.error('Fatal:', err?.message ?? err); process.exit(1); });
