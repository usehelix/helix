import { describe, it, expect } from 'vitest';
import { detectSignature, applyOverrides, amountShapeOf } from '../src/engine/auto-detect.js';

describe('Auto-Detect', () => {
  it('detects viem transaction', () => {
    expect(detectSignature([{ to: '0x123', value: 1000n }]).type).toBe('viem-tx');
  });

  it('detects viem tx with nonce', () => {
    expect(detectSignature([{ to: '0x123', value: 1000n, nonce: 5 }]).type).toBe('viem-tx');
  });

  it('detects fetch-like', () => {
    expect(detectSignature(['https://api.com/pay', { method: 'POST' }]).type).toBe('fetch');
  });

  it('detects generic payment', () => {
    expect(detectSignature([{ amount: 100, currency: 'USD' }]).type).toBe('generic-payment');
  });

  it('returns unknown for unrecognized', () => {
    expect(detectSignature([42, 'hello']).type).toBe('unknown');
  });
});

describe('Apply Overrides', () => {
  it('injects nonce into viem tx', () => {
    const sig = detectSignature([{ to: '0x123', value: 1000n, nonce: 999 }]);
    const r = applyOverrides([{ to: '0x123', value: 1000n, nonce: 999 }], { nonce: 7 }, 'refresh_nonce', sig);
    expect(r).not.toBeNull();
    expect(r![0].nonce).toBe(7);
    expect(r![0].to).toBe('0x123');
    expect(r![0].value).toBe(1000n);
  });

  it('reduces value in viem tx', () => {
    const sig = detectSignature([{ to: '0x123', value: 1000n }]);
    const r = applyOverrides([{ to: '0x123', value: 1000n }], {}, 'reduce_request', sig);
    expect(r).not.toBeNull();
    expect(r![0].value).toBe(500n);
  });

  it('bumps gas in viem tx', () => {
    const sig = detectSignature([{ to: '0x123', value: 100n, gasPrice: 1000n }]);
    const r = applyOverrides([{ to: '0x123', value: 100n, gasPrice: 1000n }], {}, 'speed_up_transaction', sig);
    expect(r).not.toBeNull();
    expect(r![0].gasPrice).toBe(1300n);
  });

  it('returns null for unknown signature', () => {
    expect(applyOverrides([42], { nonce: 5 }, 'refresh_nonce', { type: 'unknown', paramIndex: -1 })).toBeNull();
  });

  it('switches endpoint for fetch', () => {
    const sig = detectSignature(['https://old.api.com']);
    const r = applyOverrides(['https://old.api.com'], { url: 'https://new.api.com' }, 'switch_endpoint', sig);
    expect(r![0]).toBe('https://new.api.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// L1 — amount-shape type guard (2.8.1). The generic-payment repair path must
// only do scalar arithmetic on genuinely scalar amounts. Non-scalar amounts
// (Circle's amount: string[], {value,currency} objects, ambiguous strings)
// must NOT be mutated — doing so corrupts the SDK payload shape.
// ─────────────────────────────────────────────────────────────────────────
describe('amountShapeOf', () => {
  it('classifies scalar number / bigint', () => {
    expect(amountShapeOf(10)).toBe('number');
    expect(amountShapeOf(10n)).toBe('number');
  });
  it('classifies a clean numeric string', () => {
    expect(amountShapeOf('10')).toBe('numeric-string');
    expect(amountShapeOf('0.001')).toBe('numeric-string');
  });
  it('classifies a non-numeric / ambiguous string', () => {
    expect(amountShapeOf('ten')).toBe('string');
    expect(amountShapeOf('')).toBe('string');
  });
  it('classifies Circle-style array amount', () => {
    expect(amountShapeOf(['10'])).toBe('array');
  });
  it('classifies an object amount', () => {
    expect(amountShapeOf({ value: '10', currency: 'USD' })).toBe('object');
  });
  it('classifies undefined / null', () => {
    expect(amountShapeOf(undefined)).toBe('undefined');
    expect(amountShapeOf(null)).toBe('undefined');
  });
});

describe('detectSignature reports amountShape', () => {
  it('scalar number amount → number', () => {
    expect(detectSignature([{ amount: 100, currency: 'USD' }]).amountShape).toBe('number');
  });
  it('Circle array amount → array', () => {
    expect(detectSignature([{ destinationAddress: '0xabc', amount: ['10'] }]).amountShape).toBe('array');
  });
  it('numeric-string amount → numeric-string', () => {
    expect(detectSignature([{ amount: '10' }]).amountShape).toBe('numeric-string');
  });
});

describe('applyOverrides — L1 scalar-amount guard (generic-payment)', () => {
  it('reduce_request HALVES a scalar number amount (safe — behavior preserved)', () => {
    const sig = detectSignature([{ amount: 10, currency: 'USD' }]);
    const r = applyOverrides([{ amount: 10, currency: 'USD' }], {}, 'reduce_request', sig);
    expect(r).not.toBeNull();
    expect(r![0].amount).toBe(5);
  });

  it('reduce_request HALVES a numeric-string amount and round-trips to a string', () => {
    const sig = detectSignature([{ amount: '10' }]);
    const r = applyOverrides([{ amount: '10' }], {}, 'reduce_request', sig);
    expect(r).not.toBeNull();
    expect(r![0].amount).toBe('5'); // stays a string, not 5 or [0]
  });

  it('reduce_request REFUSES to mutate a Circle array amount (returns null)', () => {
    const sig = detectSignature([{ destinationAddress: '0xabc', amount: ['10'] }]);
    const r = applyOverrides([{ destinationAddress: '0xabc', amount: ['10'] }], {}, 'reduce_request', sig);
    expect(r).toBeNull(); // <-- the core bug fix: no corruption, no [0]
  });

  it('reduce_request REFUSES to mutate an object amount (returns null)', () => {
    const sig = detectSignature([{ amount: { value: '10', currency: 'USD' } }]);
    const r = applyOverrides([{ amount: { value: '10', currency: 'USD' } }], {}, 'reduce_request', sig);
    expect(r).toBeNull();
  });

  it('reduce_request REFUSES to mutate a non-numeric string amount (returns null)', () => {
    const sig = detectSignature([{ amount: 'lots' }]);
    const r = applyOverrides([{ amount: 'lots' }], {}, 'reduce_request', sig);
    expect(r).toBeNull();
  });

  it('non-reduce strategy never overwrites a non-scalar amount via generic override copy', () => {
    const sig = detectSignature([{ destinationAddress: '0xabc', amount: ['10'] }]);
    // an override that names `amount` must not clobber the array shape
    const r = applyOverrides([{ destinationAddress: '0xabc', amount: ['10'] }], { amount: 0 }, 'fix_params', sig);
    expect(r).toBeNull();
  });
});
