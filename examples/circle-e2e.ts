/**
 * examples/circle-e2e.ts
 *
 * End-to-end demo of Helix self-healing for Circle Wallets API.
 * Runs THREE scenarios in sequence, each exercising a different
 * failure code / repair strategy:
 *
 *   1. Rate limit             → wallets-api-rate-limit + serialize_and_backoff
 *   2. Param invalid          → circle-param-invalid    + hold_and_notify
 *   3. Insufficient funds     → circle-insufficient-funds + reduce_request
 *
 * Setup (free, no real funds needed):
 *   1. Sign up at developers.circle.com (Developer Sandbox)
 *   2. Create entity-secret + register it
 *   3. Create a wallet set + 1 wallet
 *   4. Fund on Arc Testnet (or Base Sepolia) from Sandbox faucet
 *   5. Set env vars below
 *   6. npx tsx examples/circle-e2e.ts
 *
 * Demo runtime: ~90 seconds end to end.
 *
 * Required env:
 *   CIRCLE_API_KEY              — from developers.circle.com
 *   CIRCLE_ENTITY_SECRET        — generated via Circle CLI
 *   CIRCLE_WALLET_ID            — the source wallet
 *   CIRCLE_DESTINATION_ADDRESS  — any address on the chosen testnet
 *                                 (alternatively, CIRCLE_SECOND_WALLET_ADDRESS)
 *
 * Optional env:
 *   CIRCLE_USDC_TOKEN_ID        — token id matching the wallet's chain
 *                                 (Arc testnet uses a chain-specific id;
 *                                 falls back to 'USDC-SEPOLIA' for Base Sepolia)
 *   HELIX_GENE_DB               — defaults to ./circle-demo-genes.db
 *   DEMO_TRANSFERS              — how many concurrent transfers in Scenario 1
 *                                 (default 10)
 *   ANTHROPIC_API_KEY           — enables LLM fallback
 */

import { wrap, createEngine } from '@helix-agent/core';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

// ──────────────────────────────────────────────────────────────────
// 0 — Configuration & sanity check
// ──────────────────────────────────────────────────────────────────

const CFG = {
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
  walletId: process.env.CIRCLE_WALLET_ID,
  destination: process.env.CIRCLE_DESTINATION_ADDRESS
              ?? process.env.CIRCLE_SECOND_WALLET_ADDRESS,
  geneDb: process.env.HELIX_GENE_DB ?? './circle-demo-genes.db',
  transfers: parseInt(process.env.DEMO_TRANSFERS ?? '10', 10),
};

for (const [k, v] of Object.entries(CFG)) {
  if (v === undefined || v === '') {
    console.error(`Missing env: ${k.toUpperCase()}`);
    process.exit(1);
  }
}

const TOKEN_ID = process.env.CIRCLE_USDC_TOKEN_ID ?? 'USDC-SEPOLIA';

// ──────────────────────────────────────────────────────────────────
// 1 — Set up Circle Wallets SDK + business functions
// ──────────────────────────────────────────────────────────────────

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: CFG.apiKey!,
  entitySecret: CFG.entitySecret!,
});

/** Plain, valid USDC transfer. No idempotencyKey — Arc Sandbox rejects it. */
async function sendUsdc(
  amount: string,
  destination: string,
): Promise<{ id: string; state: string }> {
  const resp = await circle.createTransaction({
    walletId: CFG.walletId!,
    tokenId: TOKEN_ID,
    destinationAddress: destination,
    amount: [amount],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  return {
    id: resp.data?.id ?? '',
    state: resp.data?.state ?? 'UNKNOWN',
  };
}

/** Deliberately invalid call: idempotencyKey is rejected by Arc Sandbox
 *  with code:2 (API parameter invalid). Scenario 2 uses this to demonstrate
 *  that Helix correctly classifies parameter mistakes as un-auto-repairable
 *  and routes them to hold_and_notify rather than retrying blindly. */
async function sendUsdcWithBadField(
  amount: string,
  destination: string,
): Promise<{ id: string; state: string }> {
  const resp = await circle.createTransaction({
    walletId: CFG.walletId!,
    tokenId: TOKEN_ID,
    destinationAddress: destination,
    amount: [amount],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    // Intentionally include idempotencyKey — Arc rejects with code:2.
    idempotencyKey: 'deliberate-bad-key-for-demo',
  });
  return {
    id: resp.data?.id ?? '',
    state: resp.data?.state ?? 'UNKNOWN',
  };
}

// ──────────────────────────────────────────────────────────────────
// 2 — Wrapped variants (one per scenario, different repair posture)
// ──────────────────────────────────────────────────────────────────

const safeSendUsdc = wrap(sendUsdc, {
  mode: 'auto',
  agentId: 'circle-demo-ratelimit',
  geneMapPath: CFG.geneDb,
  context: { platform: 'circle', apiLayer: 'wallets-api' },
  llm: { provider: 'anthropic', enabled: !!process.env.ANTHROPIC_API_KEY },
  verbose: true,
});

const safeBadCall = wrap(sendUsdcWithBadField, {
  mode: 'auto',
  agentId: 'circle-demo-param',
  geneMapPath: CFG.geneDb,
  context: { platform: 'circle', apiLayer: 'wallets-api' },
  // No parameterModifier — hold_and_notify doesn't mutate args.
  verbose: true,
});

// ──────────────────────────────────────────────────────────────────
// 3 — Scenario 1: parallel transfers → rate-limit repair
// ──────────────────────────────────────────────────────────────────

async function demoRateLimitRepair() {
  console.log(`\n┌─ Scenario 1: Rate limit (wallets-api-rate-limit) ────────`);
  console.log(`│ ${CFG.transfers} parallel sendUsdc() calls on Arc Testnet.`);
  console.log(`│ Expected: ~5 succeed immediately, ~5 hit code:5 (rate limit),`);
  console.log(`│ then serialize_and_backoff repairs them.`);
  console.log(`└──────────────────────────────────────────────────────────\n`);

  const startMs = Date.now();
  const attempts = Array.from({ length: CFG.transfers }, (_, i) => i);

  const results = await Promise.allSettled(
    attempts.map(async (i) => {
      const r = await safeSendUsdc('0.001', CFG.destination!);
      return { i, ...r };
    }),
  );

  const elapsed = Date.now() - startMs;
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  const repaired = results.filter(
    r => r.status === 'fulfilled' && (r.value as any)._helix?.repaired,
  ).length;

  console.log(`\n┌─ Scenario 1 result ──────────────────────────────────────`);
  console.log(`│ Total:       ${CFG.transfers}`);
  console.log(`│ Succeeded:   ${succeeded} (${repaired} self-healed)`);
  console.log(`│ Failed:      ${failed}`);
  console.log(`│ Elapsed:     ${elapsed}ms`);
  console.log(`└──────────────────────────────────────────────────────────\n`);
}

// ──────────────────────────────────────────────────────────────────
// 4 — Scenario 2: deliberate param error → hold_and_notify
// ──────────────────────────────────────────────────────────────────

async function demoParamInvalidHold() {
  console.log(`\n┌─ Scenario 2: Param invalid (circle-param-invalid) ───────`);
  console.log(`│ sendUsdcWithBadField() includes 'idempotencyKey' which the`);
  console.log(`│ Arc Sandbox rejects with code:2. Helix should diagnose this`);
  console.log(`│ as user-side, route to hold_and_notify, and NOT auto-retry`);
  console.log(`│ blindly.`);
  console.log(`└──────────────────────────────────────────────────────────\n`);

  const startMs = Date.now();
  try {
    const r = await safeBadCall('0.001', CFG.destination!);
    const repaired = (r as any)._helix?.repaired;
    const held = (r as any)._helix?.held;
    console.log(`\n┌─ Scenario 2 result ──────────────────────────────────────`);
    console.log(`│ Unexpected SUCCESS — call returned ${JSON.stringify(r)}`);
    console.log(`│ repaired=${repaired}  held=${held}`);
    console.log(`└──────────────────────────────────────────────────────────\n`);
  } catch (e: any) {
    const elapsed = Date.now() - startMs;
    const held = e?._helix?.held;
    const failureCode = e?._helix?.failureCode;
    const strategy = e?._helix?.strategy ?? e?._helix?.winner?.strategy;
    console.log(`\n┌─ Scenario 2 result ──────────────────────────────────────`);
    console.log(`│ Elapsed:       ${elapsed}ms`);
    console.log(`│ Error message: ${e?.message ?? '(none)'}`);
    console.log(`│ _helix.held:   ${held ?? '(not set on error)'}`);
    console.log(`│ failureCode:   ${failureCode ?? '(check audit log)'}`);
    console.log(`│ strategy:      ${strategy ?? '(check audit log)'}`);
    console.log(`│`);
    if (held) {
      console.log(`│ ✓ Param error correctly held for human review.`);
    } else {
      console.log(`│ (held=true marker absent on error; verify via audit log below)`);
    }
    console.log(`└──────────────────────────────────────────────────────────\n`);
  }
}

// ──────────────────────────────────────────────────────────────────
// 5 — Scenario 3: overdraft → reduce_request auto-reduces amount
// ──────────────────────────────────────────────────────────────────

async function demoInsufficientFundsAutoReduce() {
  console.log(`\n┌─ Scenario 3: Insufficient funds (circle-insufficient-funds)`);
  console.log(`│ Pre-fetching wallet balance, then requesting more than that.`);
  console.log(`│ Expected: code:155201 → reduce_request → amount lowered to`);
  console.log(`│ available balance → tx succeeds.`);
  console.log(`└──────────────────────────────────────────────────────────\n`);

  // Pre-fetch balance so reduce_request has a real number to use.
  let availableUsdc = '1';
  try {
    const b = await circle.getWalletTokenBalance({ id: CFG.walletId! });
    const usdc = b.data?.tokenBalances?.find((t: any) => t.token?.symbol === 'USDC');
    if (usdc?.amount) {
      // Reduce 50% to leave headroom for gas-as-USDC on Arc.
      availableUsdc = String(Math.max(1, Math.floor(Number(usdc.amount) * 0.5)));
    }
  } catch {
    /* swallow — fall back to '1' */
  }
  console.log(`│ Pre-fetched availableBalance for reduce_request: ${availableUsdc} USDC\n`);

  const safeSendUsdcOverdraft = wrap(sendUsdc, {
    mode: 'auto',
    agentId: 'circle-demo-balance',
    geneMapPath: CFG.geneDb,
    context: {
      platform: 'circle',
      apiLayer: 'wallets-api',
      availableBalance: availableUsdc,
    },
    parameterModifier: (args, overrides) => {
      if (overrides.amount !== undefined) {
        args[0] = String(overrides.amount);
      }
      return args;
    },
    verbose: true,
  });

  const startMs = Date.now();
  try {
    const r = await safeSendUsdcOverdraft('100', CFG.destination!);
    const elapsed = Date.now() - startMs;
    const repaired = (r as any)._helix?.repaired;
    console.log(`\n┌─ Scenario 3 result ──────────────────────────────────────`);
    console.log(`│ Elapsed:       ${elapsed}ms`);
    console.log(`│ Tx id:         ${r.id}`);
    console.log(`│ Tx state:      ${r.state}`);
    console.log(`│ _helix.repaired: ${repaired ?? '(not set)'}`);
    if (repaired) {
      console.log(`│ ✓ Auto-reduced from 100 USDC to available balance.`);
    } else {
      console.log(`│ (repaired marker absent; verify via audit log below)`);
    }
    console.log(`└──────────────────────────────────────────────────────────\n`);
  } catch (e: any) {
    const elapsed = Date.now() - startMs;
    console.log(`\n┌─ Scenario 3 result ──────────────────────────────────────`);
    console.log(`│ Elapsed:       ${elapsed}ms`);
    console.log(`│ ✗ Failed (no auto-reduce). Error: ${e?.message ?? '(none)'}`);
    console.log(`└──────────────────────────────────────────────────────────\n`);
  }
}

// ──────────────────────────────────────────────────────────────────
// 6 — Inspect the Gene Map
// ──────────────────────────────────────────────────────────────────

async function inspectGeneMap() {
  const eng = createEngine({
    mode: 'observe',
    agentId: 'inspector',
    geneMapPath: CFG.geneDb,
  });

  const geneMap = eng.getGeneMap();
  const genes = geneMap.list();
  const circleGenes = genes.filter(g => g.platforms.includes('circle'));

  console.log(`┌─ Gene Map state after demo ────────────────────────────`);
  console.log(`│ Total capsules:     ${genes.length}`);
  console.log(`│ Circle capsules:    ${circleGenes.length}`);
  console.log(`│`);
  for (const g of circleGenes) {
    console.log(`│ • ${g.failureCode}`);
    console.log(`│     api_layer:    ${g.apiLayer ?? '(none)'}`);
    console.log(`│     strategy:     ${g.strategy}`);
    console.log(`│     q_value:      ${g.qValue.toFixed(3)}`);
    console.log(`│     uses:         ${g.successCount}`);
    console.log(`│     avg_ms:       ${Math.round(g.avgRepairMs)}`);
    console.log(`│`);
  }
  console.log(`└────────────────────────────────────────────────────────\n`);

  const audit = geneMap.getAuditLog(20);
  console.log(`┌─ Recent repair audit (last ${audit.length} entries) ─────────────`);
  for (const a of audit) {
    const time = new Date(a.timestamp).toLocaleTimeString();
    const tag = a.immune ? 'IMMUNE' : 'REPAIR';
    console.log(
      `│ ${time}  ${tag}  ${a.failureCode.padEnd(28)} ` +
      `${a.strategy.padEnd(24)} ${a.success ? '✓' : '✗'} ${a.durationMs}ms`,
    );
  }
  console.log(`└────────────────────────────────────────────────────────\n`);

  geneMap.close();
}

// ──────────────────────────────────────────────────────────────────
// 7 — Main
// ──────────────────────────────────────────────────────────────────

(async () => {
  await demoRateLimitRepair();
  console.log('\n\n');
  await demoParamInvalidHold();
  console.log('\n\n');
  await demoInsufficientFundsAutoReduce();
  await inspectGeneMap();

  console.log(`✅ Demo complete.`);
  console.log(`   Gene db: ${CFG.geneDb}`);
  console.log(`   Re-run to see IMMUNE path (Q-value > 0.3 skips construct).\n`);
})().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
