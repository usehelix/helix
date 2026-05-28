import { describe, it, expect } from 'vitest';
import { circleAdapter } from '../src/platforms/circle/strategies.js';
import { SEED_GENES } from '../src/engine/seed-genes.js';
import { detectSignature, applyOverrides } from '../src/engine/auto-detect.js';
import type { FailureClassification } from '../src/engine/types.js';

// L2 (2.8.1): insufficient funds is NOT auto-repairable. Default to a safe
// halt (hold_and_notify); reduce_request fires ONLY when the caller opts into
// partial payments (allowPartial:true) — and even then the L1 type-guard
// still protects non-scalar amounts.

function insufficientFailure(): FailureClassification {
  return {
    code: 'circle-insufficient-funds',
    category: 'balance',
    severity: 'high',
    platform: 'circle',
    details: 'wallet balance < request',
    timestamp: Date.now(),
  };
}

describe('L2 — Circle insufficient-funds construct policy', () => {
  it('defaults to hold_and_notify and NEVER reduce_request (no context)', () => {
    const candidates = circleAdapter.construct(insufficientFailure());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].strategy).toBe('hold_and_notify');
    expect(candidates.some((c) => c.strategy === 'reduce_request')).toBe(false);
  });

  it('still hold_and_notify when allowPartial is explicitly false', () => {
    const candidates = circleAdapter.construct(insufficientFailure(), { allowPartial: false });
    expect(candidates[0].strategy).toBe('hold_and_notify');
  });

  it('fires reduce_request ONLY when allowPartial:true', () => {
    const candidates = circleAdapter.construct(insufficientFailure(), { allowPartial: true });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].strategy).toBe('reduce_request');
  });
});

describe('L2 — generic payment-insufficient seed gene', () => {
  it('maps to hold_and_notify, not reduce_request', () => {
    const gene = SEED_GENES.find((g) => g.failureCode === 'payment-insufficient');
    expect(gene).toBeDefined();
    expect(gene!.strategy).toBe('hold_and_notify');
  });

  it('is marked non-repairable with a neutral prior (honesty reclassification)', () => {
    const gene = SEED_GENES.find((g) => g.failureCode === 'payment-insufficient');
    expect(gene!.nonRepairable).toBe(true);
    expect(gene!.qValue).toBe(0.5); // demoted from an unvalidated 0.82
    expect(gene!.successCount).toBe(0);
  });
});

describe('L2 + L1 — allowPartial reduce_request is still subject to the L1 guard', () => {
  it('reduce_request (allowPartial) must NOT corrupt a Circle array amount', () => {
    // allowPartial re-enables the reduce_request candidate...
    const candidates = circleAdapter.construct(insufficientFailure(), { allowPartial: true });
    expect(candidates[0].strategy).toBe('reduce_request');
    // ...but applying it to an array amount is still refused (no corruption).
    const arg = { destinationAddress: '0xabc', amount: ['10'] };
    const sig = detectSignature([arg]);
    const applied = applyOverrides([arg], {}, 'reduce_request', sig);
    expect(applied).toBeNull();
  });

  it('reduce_request (allowPartial) DOES halve a genuinely scalar amount', () => {
    const arg = { amount: 10, currency: 'USD' };
    const sig = detectSignature([arg]);
    const applied = applyOverrides([arg], {}, 'reduce_request', sig);
    expect(applied).not.toBeNull();
    expect((applied![0] as { amount: number }).amount).toBe(5);
  });
});
