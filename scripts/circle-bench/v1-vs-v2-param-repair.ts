/**
 * scripts/circle-bench/v1-vs-v2-param-repair.ts
 *
 * Bench 2.2 — circle-param-invalid
 *   V1 arm: hold_and_notify (always, 0% auto-fix)
 *   V2 arm: smartParamRepair + applyParamRepair (routed action per error shape)
 *
 *   Offline — synthesizes 5 Circle error shapes matching PR #2's probe data.
 *   Each shape repeated 20 times. Measures routing correctness, not Circle's response.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  smartParamRepair,
  applyParamRepair,
  type CircleParamError,
  type ParamRepairAction,
} from '../../packages/core/dist/strategies/circle-v2/smart-param-repair.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const REPETITIONS = 20;

interface Scenario {
  name: string;
  shape: CircleParamError;
  /** A representative original call args; what V2 would mutate. */
  args: Record<string, unknown>;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'idempotencyKey-rejected',
    shape: {
      response: { data: { code: 2, message: 'API parameter invalid', errors: [{
        error: 'uuid_format',
        invalidValue: 'helix-demo-key-2026',
        location: 'idempotencyKey',
        message: "'idempotencyKey' field is not in the correct UUID format (was helix-demo-key-2026)",
      }] } },
    },
    args: {
      walletId: '7e0d2079-c1ba-51c8-9162-0b8b9536a0b4',
      destinationAddress: '0xd49a5e28...',
      tokenId: '15dc2b5d-0994-58b0-bf8c-3a0501148ee8',
      amount: ['0.001'],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      idempotencyKey: 'helix-demo-key-2026',
    },
  },
  {
    name: 'walletId-uuid-format',
    shape: {
      response: { data: { code: 2, message: 'API parameter invalid', errors: [{
        error: 'uuid_format',
        location: 'walletId',
        message: "'walletId' is not in correct UUID format",
      }] } },
    },
    args: { walletId: 'not-a-uuid', amount: ['0.001'] },
  },
  {
    name: 'amount-type-mismatch',
    shape: {
      response: { data: { code: 2, message: 'API parameter invalid', errors: [{
        location: 'amount',
        message: 'amount must be a string',
      }] } },
    },
    args: { walletId: 'w1', amount: 123 },
  },
  {
    name: 'destinationAddress-hex-error',
    shape: {
      response: { data: { code: 2, message: 'API parameter invalid', errors: [{
        location: 'destinationAddress',
        message: 'destinationAddress is not a valid hex string',
      }] } },
    },
    args: { walletId: 'w1', destinationAddress: 'ABC123' },
  },
  {
    name: 'fee-missing',
    shape: {
      response: { data: { code: 2, message: 'API parameter invalid', errors: [{
        location: 'fee',
        message: 'fee is required',
      }] } },
    },
    args: { walletId: 'w1', amount: ['0.001'] },
  },
];

interface ArmResult {
  scenario: string;
  action: string;
  field_or_resource?: string;
  auto_fix: boolean;
  description: string;
}

function v1HoldAndNotify(s: Scenario): ArmResult {
  return {
    scenario: s.name,
    action: 'hold_and_notify',
    auto_fix: false,
    description: 'v1 escalates ALL param errors — 0% auto-fix',
  };
}

function v2Repair(s: Scenario): ArmResult {
  const action: ParamRepairAction = smartParamRepair(s.shape);
  const applied = applyParamRepair(s.args, action);
  let field: string | undefined;
  if (action.type === 'strip_field' || action.type === 'coerce_type' || action.type === 'normalize_address' || action.type === 'inject_default') {
    field = action.field;
  } else if (action.type === 'refresh_metadata') {
    field = action.resource;
  }
  return {
    scenario: s.name,
    action: action.type,
    field_or_resource: field,
    auto_fix: applied.canRetry,
    description: applied.description,
  };
}

function main() {
  console.log(`Bench 2.2 — Param Repair (v1 hold_and_notify vs v2 smartParamRepair)`);
  console.log(`  Scenarios:   ${SCENARIOS.length}`);
  console.log(`  Repetitions: ${REPETITIONS} per scenario per arm (deterministic — for consistency only)\n`);

  // Run each scenario REPETITIONS times — outputs should be identical (deterministic).
  const v1Results: ArmResult[] = [];
  const v2Results: ArmResult[] = [];

  for (const s of SCENARIOS) {
    for (let i = 0; i < REPETITIONS; i++) {
      v1Results.push(v1HoldAndNotify(s));
      v2Results.push(v2Repair(s));
    }
  }

  // Per-scenario breakdown (deduped — outputs are deterministic)
  const breakdown = SCENARIOS.map(s => {
    const v1 = v1Results.find(r => r.scenario === s.name)!;
    const v2 = v2Results.find(r => r.scenario === s.name)!;
    return {
      error_type: s.name,
      v1_action: v1.action,
      v1_auto_fix: v1.auto_fix ? 'yes' : 'no',
      v2_action: v2.action,
      v2_target: v2.field_or_resource ?? '(n/a)',
      v2_auto_fix: v2.auto_fix ? 'yes' : 'no',
    };
  });

  const v1AutoFixCount = v1Results.filter(r => r.auto_fix).length;
  const v2AutoFixCount = v2Results.filter(r => r.auto_fix).length;
  const total = v1Results.length;

  console.log('── Per-scenario routing ──');
  console.table(breakdown);

  console.log('\n══════════ Bench 2.2 Summary ══════════');
  const summary = [
    {
      arm: 'v1 hold_and_notify',
      auto_fixed: `${v1AutoFixCount} / ${total}`,
      auto_fix_rate: ((v1AutoFixCount / total) * 100).toFixed(1) + '%',
      manual_escalation_rate: ((1 - v1AutoFixCount / total) * 100).toFixed(1) + '%',
    },
    {
      arm: 'v2 smartParamRepair',
      auto_fixed: `${v2AutoFixCount} / ${total}`,
      auto_fix_rate: ((v2AutoFixCount / total) * 100).toFixed(1) + '%',
      manual_escalation_rate: ((1 - v2AutoFixCount / total) * 100).toFixed(1) + '%',
    },
  ];
  console.table(summary);

  const out = {
    meta: {
      bench: 'v1-vs-v2-param-repair',
      timestamp: TIMESTAMP,
      scenarios: SCENARIOS.length,
      repetitions_per_scenario: REPETITIONS,
      total_attempts_per_arm: total,
    },
    breakdown,
    summary,
    raw_v1: v1Results.slice(0, SCENARIOS.length), // dedup for storage (deterministic)
    raw_v2: v2Results.slice(0, SCENARIOS.length),
  };
  const outFile = path.join(RESULTS_DIR, `v1-vs-v2-param-repair-${TIMESTAMP}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\n💾 Saved: ${outFile}`);
}

main();
