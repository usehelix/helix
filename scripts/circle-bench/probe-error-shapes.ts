/**
 * scripts/circle-bench/probe-error-shapes.ts
 *
 * Phase-0 diagnostic for Helix × Circle integration.
 *
 * Calls the Circle Wallets SDK directly (no Helix wrap, no PCEC) and dumps
 * the raw shape of the thrown Error for each of the three demo failure modes:
 *   1. rate limit       (10 concurrent createTransaction)
 *   2. param invalid    (idempotencyKey field — rejected by Arc Sandbox)
 *   3. insufficient funds (amount > wallet balance)
 *
 * Purpose: figure out WHERE the URL, status code, and error code actually
 * live on Circle's thrown error class, so perceive.ts can route correctly.
 */

import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

function dumpError(label: string, err: any) {
  console.log(`\n══════════════ ${label} ══════════════`);
  console.log('typeof:                ', typeof err);
  console.log('constructor:           ', err?.constructor?.name);
  console.log('message:               ', err?.message);
  console.log('code:                  ', err?.code);
  console.log('statusCode:            ', err?.statusCode);
  console.log('status:                ', err?.status);
  console.log('response.status:       ', err?.response?.status);
  console.log('response.statusText:   ', err?.response?.statusText);
  console.log('response.data:         ', JSON.stringify(err?.response?.data, null, 2));
  console.log('response.config.url:   ', err?.response?.config?.url);
  console.log('response.config.method:', err?.response?.config?.method);
  console.log('config.url:            ', err?.config?.url);
  console.log('config.baseURL:        ', err?.config?.baseURL);
  console.log('config.method:         ', err?.config?.method);
  console.log('cause:                 ', err?.cause);
  console.log('isAxiosError:          ', err?.isAxiosError);
  console.log('--- enumerable keys ---');
  for (const k of Object.keys(err ?? {})) {
    const v = err[k];
    const t = typeof v;
    const summary = t === 'object'
      ? `<${v?.constructor?.name ?? 'obj'}: ${Object.keys(v ?? {}).slice(0, 6).join(',')}>`
      : String(v).slice(0, 100);
    console.log(`  ${k}: ${summary}`);
  }
  console.log('--- own property names (incl non-enumerable) ---');
  console.log(' ', Object.getOwnPropertyNames(err ?? {}).join(', '));
  console.log('--- prototype chain ---');
  let proto = Object.getPrototypeOf(err ?? {});
  const chain: string[] = [];
  while (proto && proto !== Object.prototype) {
    chain.push(proto.constructor?.name ?? '<anon>');
    proto = Object.getPrototypeOf(proto);
  }
  console.log(' ', chain.join(' → '));
}

(async () => {
  const client = initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });

  // Resolve token id at runtime (same pattern as exp-b).
  const balRes = await client.getWalletTokenBalance({ id: process.env.CIRCLE_WALLET_ID! });
  const usdc = balRes.data?.tokenBalances?.find((b: any) => b.token?.symbol === 'USDC');
  if (!usdc) {
    console.error('Could not find USDC balance for wallet — aborting probe');
    process.exit(1);
  }
  const tokenId = usdc.token!.id;
  console.log(`USDC token id: ${tokenId}`);
  console.log(`USDC balance:  ${usdc.amount}`);

  const baseInput = {
    walletId: process.env.CIRCLE_WALLET_ID!,
    destinationAddress: process.env.CIRCLE_SECOND_WALLET_ADDRESS!,
    tokenId,
    fee: { type: 'level' as const, config: { feeLevel: 'MEDIUM' as const } },
  };

  // ──── Probe 1: rate limit (10 concurrent) ────
  console.log('\n\n>>> Probing rate limit (10 concurrent) <<<');
  const rlResults = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      client.createTransaction({ ...baseInput, amount: ['0.001'] } as any),
    ),
  );
  const okCount = rlResults.filter(r => r.status === 'fulfilled').length;
  const rejCount = rlResults.filter(r => r.status === 'rejected').length;
  console.log(`rate-limit probe: ${okCount} ok, ${rejCount} rejected`);
  const rlReject = rlResults.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (rlReject) {
    dumpError('Scenario 1 — rate limit', rlReject.reason);
  } else {
    console.log('No rate limit triggered. Try increasing concurrency.');
  }

  await new Promise(r => setTimeout(r, 10000));

  // ──── Probe 2: param invalid (idempotencyKey) ────
  console.log('\n\n>>> Probing param invalid (idempotencyKey) <<<');
  try {
    await client.createTransaction({
      ...baseInput,
      amount: ['0.001'],
      idempotencyKey: 'deliberate-probe-bad-key',
    } as any);
    console.log('Unexpected: param-invalid probe did NOT throw');
  } catch (err) {
    dumpError('Scenario 2 — param invalid', err);
  }

  await new Promise(r => setTimeout(r, 3000));

  // ──── Probe 3: insufficient funds (amount > balance) ────
  console.log('\n\n>>> Probing insufficient funds (100 USDC, have ~14) <<<');
  try {
    await client.createTransaction({
      ...baseInput,
      amount: ['100'],
    } as any);
    console.log('Unexpected: overdraft probe did NOT throw');
  } catch (err) {
    dumpError('Scenario 3 — insufficient funds', err);
  }
})().catch(e => {
  console.error('Probe harness crashed:', e);
  process.exit(1);
});
