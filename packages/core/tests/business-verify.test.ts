import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrap, shutdown } from '../src/engine/wrap.js';
import { GeneMap } from '../src/engine/gene-map.js';

afterEach(() => { shutdown(); });

describe('Business-Level Verify', () => {

  it('verify pass — result returned normally', async () => {
    let callCount = 0;
    const fn = async (params: { amount: number }) => {
      callCount++;
      if (callCount === 1) throw new Error('nonce mismatch');
      return { amount: params.amount, status: 'success' };
    };

    const safeFn = wrap(fn, {
      mode: 'auto',
      geneMapPath: ':memory:',
      logLevel: 'silent',
      verify: (result: any, args: any[]) => {
        return result.amount === args[0].amount;
      },
    });

    const result = await safeFn({ amount: 100 });
    expect(result.amount).toBe(100);
    expect(result.status).toBe('success');
  });

  it('verify fail — throws with verifyFailed flag', async () => {
    let callCount = 0;
    const fn = async (params: { amount: number }) => {
      callCount++;
      if (callCount === 1) throw new Error('nonce mismatch');
      return { amount: 50, status: 'success' }; // wrong amount
    };

    const safeFn = wrap(fn, {
      mode: 'auto',
      geneMapPath: ':memory:',
      logLevel: 'silent',
      verify: (result: any, args: any[]) => {
        return result.amount === args[0].amount; // 50 !== 100
      },
    });

    try {
      await safeFn({ amount: 100 });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err._helix).toBeDefined();
      expect(err._helix.verifyFailed).toBe(true);
      expect(err.message).toContain('business verification failed');
    }
  });

  it('verify not provided — no effect', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount === 1) throw new Error('nonce mismatch');
      return { ok: true };
    };

    const safeFn = wrap(fn, {
      mode: 'auto',
      geneMapPath: ':memory:',
      logLevel: 'silent',
    });

    const result = await safeFn();
    expect(result.ok).toBe(true);
  });

  it('verify can be async', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount === 1) throw new Error('server error');
      return { txHash: '0xabc' };
    };

    const safeFn = wrap(fn, {
      mode: 'auto',
      geneMapPath: ':memory:',
      logLevel: 'silent',
      verify: async (result: any) => {
        await new Promise(r => setTimeout(r, 10));
        return result.txHash.startsWith('0x');
      },
    });

    const result = await safeFn();
    expect(result.txHash).toBe('0xabc');
  });

  it('verify callback error — treated as failure', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount === 1) throw new Error('nonce mismatch');
      return { data: 'ok' };
    };

    const safeFn = wrap(fn, {
      mode: 'auto',
      geneMapPath: ':memory:',
      logLevel: 'silent',
      verify: () => {
        throw new Error('verify crashed');
      },
    });

    try {
      await safeFn();
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).toBe('verify crashed');
    }
  });

  it('first call success (no repair) — verify not called', async () => {
    let verifyCalled = false;
    const fn = async () => ({ ok: true });

    const safeFn = wrap(fn, {
      mode: 'auto',
      geneMapPath: ':memory:',
      logLevel: 'silent',
      verify: () => {
        verifyCalled = true;
        return true;
      },
    });

    const result = await safeFn();
    expect(result.ok).toBe(true);
    expect(verifyCalled).toBe(false);
  });

  it('verify receives original args, not modified args', async () => {
    let callCount = 0;
    let capturedArgs: unknown[] | null = null;

    const fn = async (params: { to: string; amount: number }) => {
      callCount++;
      if (callCount === 1) throw new Error('nonce mismatch');
      return { to: params.to, amount: params.amount };
    };

    const safeFn = wrap(fn, {
      mode: 'auto',
      geneMapPath: ':memory:',
      logLevel: 'silent',
      verify: (result: any, originalArgs: any[]) => {
        capturedArgs = originalArgs;
        return true;
      },
    });

    await safeFn({ to: '0xRecipient', amount: 100 });
    expect(capturedArgs).not.toBeNull();
    expect((capturedArgs![0] as any).to).toBe('0xRecipient');
    expect((capturedArgs![0] as any).amount).toBe(100);
  });

  // 2.8.1: an underpay that "succeeds" must be caught by verify, penalize the
  // gene (q decremented via recordFailure), and surface as a failure WITHOUT
  // further Self-Refine retries.
  it('verify-false on an underpay: decrements gene q, records failure, no extra retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helix-verify-'));
    const dbPath = join(dir, 'genes.db');
    let calls = 0;

    const fn = async (p: { amount: number }) => {
      calls++;
      if (calls === 1) throw new Error('nonce mismatch'); // → refresh_nonce repair
      return { amount: 50 }; // UNDERPAID: requested 100, "paid" 50
    };

    const safe = wrap(fn, {
      mode: 'auto',
      geneMapPath: dbPath,
      logLevel: 'silent',
      verify: (r: any, a: any[]) => r.amount === a[0].amount, // 50 !== 100 → false
    });

    await expect(safe({ amount: 100 })).rejects.toThrow(/business verification failed/i);
    // verify-false exits immediately: 1 original + 1 repair-retry, NO further loop.
    expect(calls).toBe(2);

    // Inspect the persisted gene: recordFailure ran → failure counted + q down.
    shutdown();
    const gm = new GeneMap(dbPath);
    const gene = gm.lookup('nonce-mismatch', 'nonce');
    expect(gene).not.toBeNull();
    expect(gene!.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(gene!.qValue).toBeLessThan(0.5); // decremented from the 0.50 seed prior
    gm.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
