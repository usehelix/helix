/**
 * scripts/circle-bench/v2-smart-param-e2e.ts
 *
 * Bench 2.4 — Real end-to-end validation for smart_param_repair against
 * live Circle Sandbox + Arc Testnet. Validates the full pipeline:
 *
 *   deliberate trigger → Circle returns code:2 → smartParamRepair routes →
 *     applyParamRepair mutates args → retry (or hold) → outcome verified.
 *
 * Three groups, 20 trials each:
 *   A) idempotencyKey rejection         → strip_field      → real tx submitted
 *   B) tokenId = fake UUID              → refresh_metadata → diagnostic, no retry
 *   C) walletId = "not-a-uuid"          → hold_and_notify  → diagnostic, no retry
 *
 * Only Group A actually submits transactions (after the strip). B and C
 * deliberately hold, so they consume no USDC.
 *
 * Uses the bench-local Circle SDK v7.3.0 (raw AxiosError shape with
 * response.data.errors[]) — which is what smartParamRepair expects.
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import {
  smartParamRepair,
  applyParamRepair,
  type CircleParamError,
  type ParamRepairAction,
} from '../../packages/core/dist/strategies/circle-v2/smart-param-repair.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const TRIALS_PER_GROUP = parseInt(process.env.BENCH_TRIALS ?? '20', 10);
const AMOUNT_USDC = process.env.BENCH_AMOUNT ?? '0.0001';
const COOLDOWN_MS = parseInt(process.env.BENCH_COOLDOWN_MS ?? '2000', 10);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing ${name}`); process.exit(1); }
  return v;
}

type Outcome =
  | 'tx-submitted'        // Group A success
  | 'hold-with-diagnostic'// Group B/C expected
  | 'unexpected';         // any deviation from the design

interface TrialResult {
  group: 'A' | 'B' | 'C';
  trial: number;
  /** Did the deliberate trigger produce the expected error (code:2 or similar)? */
  triggered: boolean;
  triggerCode?: number | string;
  triggerMessage?: string;
  /** Action smartParamRepair routed to. */
  routedAction?: ParamRepairAction['type'];
  routedTarget?: string;
  /** Whether the action's canRetry flag matched what the group expected. */
  expectedCanRetry: boolean;
  actualCanRetry?: boolean;
  /** Final outcome label. */
  finalOutcome: Outcome;
  /** Successful tx id (Group A only). */
  txId?: string;
  diagnostic?: string;
  /** If outcome=unexpected, the reason. */
  unexpectedReason?: string;
}

interface GroupSummary {
  group: 'A' | 'B' | 'C';
  label: string;
  trials: number;
  triggered: number;
  routed_correctly: number;
  final_success: number;
  pct: string;
  threshold_met: boolean;
}

// ──────────────────────────────────────────────────────────────────
// Per-group runners
// ──────────────────────────────────────────────────────────────────

async function runGroupA(
  client: any, walletId: string, tokenId: string, destinationAddress: string, trial: number,
): Promise<TrialResult> {
  const baseArgs: any = {
    walletId, tokenId, destinationAddress,
    amount: [AMOUNT_USDC],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    idempotencyKey: `deliberate-trigger-${Date.now()}-${trial}`,
  };

  try {
    const r = await client.createTransaction(baseArgs);
    return {
      group: 'A', trial, triggered: false,
      expectedCanRetry: true,
      finalOutcome: 'unexpected',
      unexpectedReason: `Circle accepted the deliberate idempotencyKey trigger (txId=${r.data?.id}); Sandbox behavior may have changed`,
    };
  } catch (err: any) {
    const triggerCode = err?.response?.data?.code;
    const triggerMessage = err?.response?.data?.message;
    const action = smartParamRepair({ response: err.response } as CircleParamError);

    const target = (
      action.type === 'strip_field' ? action.field :
      action.type === 'coerce_type' || action.type === 'normalize_address' || action.type === 'inject_default' ? action.field :
      action.type === 'refresh_metadata' ? action.resource :
      undefined
    );

    if (action.type !== 'strip_field') {
      return {
        group: 'A', trial, triggered: true, triggerCode, triggerMessage,
        routedAction: action.type, routedTarget: target,
        expectedCanRetry: true,
        finalOutcome: 'unexpected',
        unexpectedReason: `Expected strip_field; got ${action.type}`,
      };
    }

    const applied = applyParamRepair(baseArgs, action);
    if (!applied.canRetry) {
      return {
        group: 'A', trial, triggered: true, triggerCode, triggerMessage,
        routedAction: action.type, routedTarget: target,
        expectedCanRetry: true, actualCanRetry: false,
        finalOutcome: 'unexpected',
        unexpectedReason: 'strip_field returned canRetry=false',
      };
    }

    try {
      const resp = await client.createTransaction(applied.args);
      return {
        group: 'A', trial, triggered: true, triggerCode, triggerMessage,
        routedAction: action.type, routedTarget: target,
        expectedCanRetry: true, actualCanRetry: true,
        finalOutcome: 'tx-submitted',
        txId: resp.data?.id,
        diagnostic: applied.description,
      };
    } catch (retryErr: any) {
      const retryMsg = retryErr?.response?.data?.message ?? retryErr?.message;
      return {
        group: 'A', trial, triggered: true, triggerCode, triggerMessage,
        routedAction: action.type, routedTarget: target,
        expectedCanRetry: true, actualCanRetry: true,
        finalOutcome: 'unexpected',
        unexpectedReason: `Retry after strip failed: ${retryMsg}`,
      };
    }
  }
}

async function runGroupB(
  client: any, walletId: string, destinationAddress: string, trial: number,
): Promise<TrialResult> {
  const baseArgs: any = {
    walletId,
    tokenId: '00000000-0000-0000-0000-000000000000',
    destinationAddress,
    amount: [AMOUNT_USDC],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  };

  try {
    await client.createTransaction(baseArgs);
    return {
      group: 'B', trial, triggered: false,
      expectedCanRetry: false,
      finalOutcome: 'unexpected',
      unexpectedReason: 'Circle accepted fake all-zeros tokenId',
    };
  } catch (err: any) {
    const triggerCode = err?.response?.data?.code;
    const triggerMessage = err?.response?.data?.message;
    const action = smartParamRepair({ response: err.response } as CircleParamError);
    const applied = applyParamRepair(baseArgs, action);

    const correct = action.type === 'refresh_metadata' && action.resource === 'tokenId';
    return {
      group: 'B', trial, triggered: true, triggerCode, triggerMessage,
      routedAction: action.type,
      routedTarget: action.type === 'refresh_metadata' ? action.resource : undefined,
      expectedCanRetry: false, actualCanRetry: applied.canRetry,
      finalOutcome: correct && !applied.canRetry ? 'hold-with-diagnostic' : 'unexpected',
      diagnostic: applied.description,
      unexpectedReason: correct ? undefined : `Expected refresh_metadata/tokenId; got ${action.type}/${action.type === 'refresh_metadata' ? action.resource : '?'}`,
    };
  }
}

async function runGroupC(
  client: any, tokenId: string, destinationAddress: string, trial: number,
): Promise<TrialResult> {
  const baseArgs: any = {
    walletId: 'not-a-uuid',
    tokenId,
    destinationAddress,
    amount: [AMOUNT_USDC],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  };

  try {
    await client.createTransaction(baseArgs);
    return {
      group: 'C', trial, triggered: false,
      expectedCanRetry: false,
      finalOutcome: 'unexpected',
      unexpectedReason: 'Circle accepted "not-a-uuid" as walletId',
    };
  } catch (err: any) {
    const triggerCode = err?.response?.data?.code;
    const triggerMessage = err?.response?.data?.message;
    const action = smartParamRepair({ response: err.response } as CircleParamError);
    const applied = applyParamRepair(baseArgs, action);

    const correctAction = action.type === 'hold_and_notify';
    const diagnosticMentionsUuid = /uuid/i.test(applied.description);
    const allGood = correctAction && diagnosticMentionsUuid && !applied.canRetry;

    return {
      group: 'C', trial, triggered: true, triggerCode, triggerMessage,
      routedAction: action.type,
      expectedCanRetry: false, actualCanRetry: applied.canRetry,
      finalOutcome: allGood ? 'hold-with-diagnostic' : 'unexpected',
      diagnostic: applied.description,
      unexpectedReason: allGood ? undefined : `correctAction=${correctAction} mentionsUuid=${diagnosticMentionsUuid} canRetry=${applied.canRetry}`,
    };
  }
}

// ──────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = requireEnv('CIRCLE_API_KEY');
  const entitySecret = requireEnv('CIRCLE_ENTITY_SECRET');
  const walletId = requireEnv('CIRCLE_WALLET_ID');
  const destinationAddress = requireEnv('CIRCLE_SECOND_WALLET_ADDRESS');

  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  const balRes = await client.getWalletTokenBalance({ id: walletId });
  const usdc = balRes.data?.tokenBalances?.find((b: any) => b.token?.symbol === 'USDC');
  const tokenId = (usdc?.token as any)?.id;
  const balance = parseFloat(usdc?.amount ?? '0');
  if (!tokenId) { console.error('No USDC tokenId'); process.exit(1); }

  const usdcNeeded = parseFloat(AMOUNT_USDC) * TRIALS_PER_GROUP; // Group A only
  console.log(`Bench 2.4 — Real E2E smart_param_repair (3 groups × ${TRIALS_PER_GROUP} trials)`);
  console.log(`  Wallet balance: ${balance} USDC`);
  console.log(`  USDC needed:    ~${usdcNeeded.toFixed(4)} USDC (Group A only — B and C hold, no submission)\n`);

  if (balance < usdcNeeded) { console.error('Insufficient USDC'); process.exit(1); }

  const all: TrialResult[] = [];

  console.log('── Group A: idempotencyKey strip → real Arc tx ──');
  for (let i = 1; i <= TRIALS_PER_GROUP; i++) {
    const r = await runGroupA(client, walletId, tokenId, destinationAddress, i);
    all.push(r);
    const tag = r.finalOutcome === 'tx-submitted' ? '✓' : r.finalOutcome === 'unexpected' ? '✗' : '·';
    console.log(`  ${tag} trial ${i}: trig=${r.triggered} routed=${r.routedAction ?? '(none)'} → ${r.finalOutcome}${r.txId ? ' tx=' + r.txId.slice(0, 8) : ''}${r.unexpectedReason ? ' ‹' + r.unexpectedReason.slice(0, 60) + '›' : ''}`);
    await sleep(COOLDOWN_MS);
  }

  console.log('\n── Group B: fake tokenId → refresh_metadata ──');
  for (let i = 1; i <= TRIALS_PER_GROUP; i++) {
    const r = await runGroupB(client, walletId, destinationAddress, i);
    all.push(r);
    const tag = r.finalOutcome === 'hold-with-diagnostic' ? '✓' : r.finalOutcome === 'unexpected' ? '✗' : '·';
    console.log(`  ${tag} trial ${i}: trig=${r.triggered} routed=${r.routedAction ?? '(none)'} → ${r.finalOutcome}${r.unexpectedReason ? ' ‹' + r.unexpectedReason.slice(0, 80) + '›' : ''}`);
    await sleep(COOLDOWN_MS);
  }

  console.log('\n── Group C: "not-a-uuid" walletId → hold_and_notify ──');
  for (let i = 1; i <= TRIALS_PER_GROUP; i++) {
    const r = await runGroupC(client, tokenId, destinationAddress, i);
    all.push(r);
    const tag = r.finalOutcome === 'hold-with-diagnostic' ? '✓' : r.finalOutcome === 'unexpected' ? '✗' : '·';
    console.log(`  ${tag} trial ${i}: trig=${r.triggered} routed=${r.routedAction ?? '(none)'} → ${r.finalOutcome}${r.unexpectedReason ? ' ‹' + r.unexpectedReason.slice(0, 80) + '›' : ''}`);
    await sleep(COOLDOWN_MS);
  }

  // ── Aggregate ─────────────────────────────────────────────────
  function summarize(group: 'A' | 'B' | 'C', label: string, successOutcome: Outcome, threshold: number): GroupSummary {
    const slice = all.filter(r => r.group === group);
    const triggered = slice.filter(r => r.triggered).length;
    const routedCorrectly = slice.filter(r =>
      group === 'A' ? r.routedAction === 'strip_field' :
      group === 'B' ? r.routedAction === 'refresh_metadata' :
      r.routedAction === 'hold_and_notify',
    ).length;
    const finalOk = slice.filter(r => r.finalOutcome === successOutcome).length;
    return {
      group, label,
      trials: slice.length,
      triggered,
      routed_correctly: routedCorrectly,
      final_success: finalOk,
      pct: ((100 * finalOk) / slice.length).toFixed(1) + '%',
      threshold_met: finalOk >= threshold,
    };
  }

  const summaryA = summarize('A', 'idempotencyKey strip → tx submitted', 'tx-submitted', Math.ceil(TRIALS_PER_GROUP * 0.9));
  const summaryB = summarize('B', 'fake tokenId → refresh_metadata',     'hold-with-diagnostic', TRIALS_PER_GROUP);
  const summaryC = summarize('C', '"not-a-uuid" walletId → hold',         'hold-with-diagnostic', TRIALS_PER_GROUP);

  console.log('\n══════════ Bench 2.4 Summary ══════════');
  console.table([summaryA, summaryB, summaryC]);

  const allMet = summaryA.threshold_met && summaryB.threshold_met && summaryC.threshold_met;
  console.log(`Threshold met: ${allMet ? 'ALL ✓' : 'SOME MISSED ✗'}`);

  const out = {
    meta: {
      bench: 'v2-smart-param-e2e',
      timestamp: TIMESTAMP,
      trialsPerGroup: TRIALS_PER_GROUP,
      amountUsdc: AMOUNT_USDC,
      cooldownMs: COOLDOWN_MS,
      walletId, tokenId, destination: destinationAddress,
    },
    trials: all,
    summary: [summaryA, summaryB, summaryC],
    thresholds_met: allMet,
  };
  const outFile = path.join(RESULTS_DIR, `v2-smart-param-e2e-${TIMESTAMP}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\n💾 Saved: ${outFile}`);
}

main().catch(err => { console.error('Bench 2.4 failed:', err); process.exit(1); });
