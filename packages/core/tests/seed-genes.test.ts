import { describe, it, expect, afterEach } from 'vitest';
import { GeneMap } from '../src/engine/gene-map.js';
import { SEED_GENES } from '../src/engine/seed-genes.js';

describe('Seed Gene Map (D9)', () => {
  let geneMap: GeneMap;

  afterEach(() => { geneMap.close(); });

  it('seeds empty Gene Map with pre-loaded genes', () => {
    geneMap = new GeneMap(':memory:');
    expect(geneMap.immuneCount()).toBe(SEED_GENES.length);
  });

  it('generic priors are normalized to a neutral 0.50 (2.8.1 honesty audit)', () => {
    geneMap = new GeneMap(':memory:');
    const nonce = geneMap.lookup('verification-failed', 'signature');
    expect(nonce).not.toBeNull();
    // Was an unvalidated 0.70 prior in 2.8.0; demoted to a neutral 0.50 since
    // no real repair was ever validated. Strategy unchanged.
    expect(nonce!.qValue).toBe(0.5);
    expect(nonce!.strategy).toBe('refresh_nonce');

    // No generic prior should ship ABOVE the neutral 0.50 without evidence.
    for (const g of SEED_GENES) {
      if (g.platforms.includes('circle')) continue; // Circle audited separately
      expect(g.qValue).toBeLessThanOrEqual(0.5);
    }
  });

  it('does not overwrite existing genes on re-seed', () => {
    geneMap = new GeneMap(':memory:');
    // Modify a gene
    geneMap.recordSuccess('verification-failed', 'signature', 50);
    const before = geneMap.lookup('verification-failed', 'signature');

    // Re-seed should be a no-op
    const result = geneMap.seed();
    expect(result.seeded).toBe(0);

    const after = geneMap.lookup('verification-failed', 'signature');
    // q_value should have changed from recordSuccess, not reset by seed
    expect(after!.qValue).toBeGreaterThanOrEqual(before!.qValue);
  });

  it('new GeneMap is pre-immunized for common errors', () => {
    geneMap = new GeneMap(':memory:');
    expect(geneMap.lookup('verification-failed', 'signature')).not.toBeNull();
    expect(geneMap.lookup('rate-limited', 'auth')).not.toBeNull();
    expect(geneMap.lookup('token-uninitialized', 'network')).not.toBeNull();
    expect(geneMap.lookup('payment-insufficient', 'balance')).not.toBeNull();
  });

  it('seed genes cover multiple platforms', () => {
    geneMap = new GeneMap(':memory:');
    const nonce = geneMap.lookup('verification-failed', 'signature');
    expect(nonce!.platforms).toContain('privy');
    expect(nonce!.platforms).toContain('coinbase');
  });
});
