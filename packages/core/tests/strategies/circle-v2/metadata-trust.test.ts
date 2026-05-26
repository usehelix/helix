import { describe, it, expect, vi } from 'vitest';
import {
  verifyTokenMetadata,
  NATIVE_USDC_DECIMALS,
  type TokenMetadata,
  type MetadataTrustResult,
} from '../../../src/strategies/circle-v2/metadata-trust.js';

// ──────────────────────────────────────────────────────────────────
// Helpers — mock viem PublicClient (readContract only)
// ──────────────────────────────────────────────────────────────────

function makeMockClient(
  /** Sequential values readContract should resolve to, in call order. */
  values: ReadonlyArray<unknown>,
): { client: { readContract: ReturnType<typeof vi.fn> }; readContract: ReturnType<typeof vi.fn> } {
  const readContract = vi.fn();
  for (const v of values) {
    readContract.mockResolvedValueOnce(v);
  }
  return { client: { readContract }, readContract };
}

function makeMockClientThrows(): { client: { readContract: ReturnType<typeof vi.fn> }; readContract: ReturnType<typeof vi.fn> } {
  const readContract = vi.fn().mockRejectedValue(new Error('RPC connection refused'));
  return { client: { readContract }, readContract };
}

const USDC_ARC_ADDR = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;

// ──────────────────────────────────────────────────────────────────
// On-chain (Priority 1) path
// ──────────────────────────────────────────────────────────────────

describe('verifyTokenMetadata — Priority 1 (on-chain ERC-20)', () => {
  it('on-chain decimals matches API → trusted=true, source=on-chain', async () => {
    const { client, readContract } = makeMockClient([6, 'USDC']);
    const api: TokenMetadata = { decimals: 6, symbol: 'USDC', address: USDC_ARC_ADDR };

    const r = await verifyTokenMetadata(api, { publicClient: client as any });

    expect(r.trusted).toBe(true);
    expect(r.discrepancies).toEqual([]);
    expect(r.source).toBe('on-chain');
    expect(r.verified.decimals).toBe(6);
    expect(readContract).toHaveBeenCalledTimes(2);
  });

  it('on-chain decimals DIFFERS from API → discrepancy, verified overrides', async () => {
    const { client } = makeMockClient([6, 'USDC']);
    const api: TokenMetadata = { decimals: 18, symbol: 'USDC', address: USDC_ARC_ADDR };

    const r = await verifyTokenMetadata(api, { publicClient: client as any });

    expect(r.trusted).toBe(false);
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toMatch(/decimals.*API=18.*on-chain=6/);
    expect(r.verified.decimals).toBe(6);
    expect(r.apiReported.decimals).toBe(18); // original preserved
    expect(r.source).toBe('on-chain');
  });

  it('on-chain symbol DIFFERS from API → discrepancy with quoted strings', async () => {
    const { client } = makeMockClient([6, 'USDC.e']);
    const api: TokenMetadata = { decimals: 6, symbol: 'USDC', address: USDC_ARC_ADDR };

    const r = await verifyTokenMetadata(api, { publicClient: client as any });

    expect(r.trusted).toBe(false);
    expect(r.discrepancies.some(d => /symbol.*"USDC".*"USDC\.e"/.test(d))).toBe(true);
    expect(r.verified.symbol).toBe('USDC.e');
    expect(r.apiReported.symbol).toBe('USDC');
  });

  it('both decimals AND symbol differ → two discrepancies', async () => {
    const { client } = makeMockClient([6, 'USDC.e']);
    const api: TokenMetadata = { decimals: 18, symbol: 'USDC', address: USDC_ARC_ADDR };

    const r = await verifyTokenMetadata(api, { publicClient: client as any });

    expect(r.discrepancies).toHaveLength(2);
    expect(r.verified.decimals).toBe(6);
    expect(r.verified.symbol).toBe('USDC.e');
  });

  it('readContract for decimals THROWS → falls through (not crash)', async () => {
    const { client } = makeMockClientThrows();
    const api: TokenMetadata = { decimals: 18, symbol: 'USDC', address: USDC_ARC_ADDR };

    const r = await verifyTokenMetadata(api, { publicClient: client as any });

    // No on-chain success. With no chain given, Priority 2 also skipped.
    // Returns 'api-trusted'.
    expect(r.source).toBe('api-trusted');
    expect(r.trusted).toBe(true);
    expect(r.verified.decimals).toBe(18); // unchanged
  });

  it('readContract for SYMBOL throws but decimals succeeds → discrepancy on decimals only', async () => {
    // First call (decimals) succeeds, second (symbol) throws.
    // Legacy ERC-20s without symbol() should not fail the whole verification.
    const readContract = vi.fn()
      .mockResolvedValueOnce(6)
      .mockRejectedValueOnce(new Error('symbol() not implemented'));
    const client = { readContract };
    const api: TokenMetadata = { decimals: 18, symbol: 'USDC', address: USDC_ARC_ADDR };

    const r = await verifyTokenMetadata(api, { publicClient: client as any });

    expect(r.source).toBe('on-chain');
    expect(r.discrepancies).toHaveLength(1); // only decimals; symbol skipped
    expect(r.verified.decimals).toBe(6);
    expect(r.verified.symbol).toBe('USDC'); // unchanged (couldn't verify)
  });

  it('readContract called with correct ABI + address', async () => {
    const { client, readContract } = makeMockClient([6, 'USDC']);
    const api: TokenMetadata = { decimals: 6, symbol: 'USDC', address: USDC_ARC_ADDR };

    await verifyTokenMetadata(api, { publicClient: client as any });

    const call1 = readContract.mock.calls[0][0];
    expect(call1.address).toBe(USDC_ARC_ADDR);
    expect(call1.functionName).toBe('decimals');
    expect(call1.abi[0].outputs[0].type).toBe('uint8');

    const call2 = readContract.mock.calls[1][0];
    expect(call2.functionName).toBe('symbol');
    expect(call2.abi[0].outputs[0].type).toBe('string');
  });

  it('isNative=true SKIPS on-chain check even with publicClient + address', async () => {
    const { client, readContract } = makeMockClient([6, 'USDC']);
    const api: TokenMetadata = { decimals: 18, symbol: 'USDC', address: USDC_ARC_ADDR, isNative: true };

    const r = await verifyTokenMetadata(api, { publicClient: client as any, chain: 'arc-testnet' });

    expect(readContract).not.toHaveBeenCalled();
    // Falls through to Priority 2 — ground-truth table for arc-testnet:USDC.
    expect(r.source).toBe('ground-truth-table');
    expect(r.verified.decimals).toBe(6);
  });
});

// ──────────────────────────────────────────────────────────────────
// Ground-truth table (Priority 2) path
// ──────────────────────────────────────────────────────────────────

describe('verifyTokenMetadata — Priority 2 (ground-truth table)', () => {
  it('native USDC on arc-testnet, API says 18 → ground-truth override to 6', async () => {
    const api: TokenMetadata = { decimals: 18, symbol: 'USDC', isNative: true };

    const r = await verifyTokenMetadata(api, { chain: 'arc-testnet' });

    expect(r.source).toBe('ground-truth-table');
    expect(r.trusted).toBe(false);
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toMatch(/decimals.*API=18.*known-correct=6/);
    expect(r.verified.decimals).toBe(6);
    expect(r.apiReported.decimals).toBe(18);
  });

  it('native USDC on known chain, API already agrees → trusted=true, source=ground-truth-table', async () => {
    const api: TokenMetadata = { decimals: 6, symbol: 'USDC', isNative: true };

    const r = await verifyTokenMetadata(api, { chain: 'base-sepolia' });

    expect(r.source).toBe('ground-truth-table');
    expect(r.trusted).toBe(true);
    expect(r.discrepancies).toEqual([]);
  });

  it('chain lookup is case-insensitive', async () => {
    const api: TokenMetadata = { decimals: 18, symbol: 'USDC' };
    const r = await verifyTokenMetadata(api, { chain: 'ARC-Testnet' });
    expect(r.source).toBe('ground-truth-table');
    expect(r.verified.decimals).toBe(6);
  });

  it('symbol check is case-insensitive (matches usdc / USDC / Usdc)', async () => {
    const api: TokenMetadata = { decimals: 18, symbol: 'usdc' };
    const r = await verifyTokenMetadata(api, { chain: 'arc-testnet' });
    expect(r.source).toBe('ground-truth-table');
    expect(r.verified.decimals).toBe(6);
  });

  it('unknown chain → falls through to api-trusted', async () => {
    const api: TokenMetadata = { decimals: 18, symbol: 'USDC' };
    const r = await verifyTokenMetadata(api, { chain: 'some-l3-i-have-not-heard-of' });
    expect(r.source).toBe('api-trusted');
    expect(r.trusted).toBe(true); // no source available to disagree
    expect(r.verified.decimals).toBe(18);
  });

  it('non-USDC token on known chain → does not match ground-truth (USDC-only table)', async () => {
    const api: TokenMetadata = { decimals: 18, symbol: 'WETH' };
    const r = await verifyTokenMetadata(api, { chain: 'arc-testnet' });
    expect(r.source).toBe('api-trusted');
  });
});

// ──────────────────────────────────────────────────────────────────
// API-trusted (Priority 3) path
// ──────────────────────────────────────────────────────────────────

describe('verifyTokenMetadata — Priority 3 (api-trusted fallback)', () => {
  it('no publicClient, no chain → source=api-trusted, trusted=true', async () => {
    const api: TokenMetadata = { decimals: 18, symbol: 'USDC' };
    const r = await verifyTokenMetadata(api);
    expect(r.source).toBe('api-trusted');
    expect(r.trusted).toBe(true);
    expect(r.discrepancies).toEqual([]);
    expect(r.verified).toEqual(api); // unchanged
  });

  it('empty apiMetadata fields handled gracefully (no address, no symbol)', async () => {
    const api: TokenMetadata = { decimals: 0 };
    const r = await verifyTokenMetadata(api, { chain: 'arc-testnet' });
    expect(r.source).toBe('api-trusted'); // no symbol → ground-truth skipped
    expect(r.verified).toEqual(api);
  });
});

// ──────────────────────────────────────────────────────────────────
// Caching
// ──────────────────────────────────────────────────────────────────

describe('verifyTokenMetadata — caching', () => {
  it('cache hit returns the cached result without calling readContract', async () => {
    const { client, readContract } = makeMockClient([6, 'USDC']);
    const cache = new Map<string, MetadataTrustResult>();
    const api: TokenMetadata = { decimals: 18, symbol: 'USDC', address: USDC_ARC_ADDR };

    const r1 = await verifyTokenMetadata(api, { publicClient: client as any, cache });
    expect(readContract).toHaveBeenCalledTimes(2); // first call queries
    expect(r1.verified.decimals).toBe(6);

    const r2 = await verifyTokenMetadata(api, { publicClient: client as any, cache });
    expect(readContract).toHaveBeenCalledTimes(2); // STILL 2 — cache hit, no new query
    expect(r2).toBe(r1); // identical reference (cache returns the same object)
  });

  it('different chains with same address keep separate cache entries', async () => {
    // Two calls, different chain context, same address — should both query
    // because cache key includes chain.
    const readContract = vi.fn()
      .mockResolvedValueOnce(6).mockResolvedValueOnce('USDC')   // call set 1
      .mockResolvedValueOnce(6).mockResolvedValueOnce('USDC');  // call set 2
    const client = { readContract };
    const cache = new Map<string, MetadataTrustResult>();
    const api: TokenMetadata = { decimals: 6, symbol: 'USDC', address: USDC_ARC_ADDR };

    await verifyTokenMetadata(api, { publicClient: client as any, chain: 'arc-testnet', cache });
    await verifyTokenMetadata(api, { publicClient: client as any, chain: 'base-sepolia', cache });

    expect(readContract).toHaveBeenCalledTimes(4); // 2 chains × 2 calls each
    expect(cache.size).toBe(2);
  });

  it('cache key uses address when present; symbol when address missing', async () => {
    const cache = new Map<string, MetadataTrustResult>();
    const apiByAddr: TokenMetadata = { decimals: 18, symbol: 'USDC', address: USDC_ARC_ADDR };
    const apiBySym: TokenMetadata = { decimals: 18, symbol: 'USDC' }; // no address

    await verifyTokenMetadata(apiByAddr, { chain: 'arc-testnet', cache });
    await verifyTokenMetadata(apiBySym, { chain: 'arc-testnet', cache });

    // Different cache keys (one includes address, other uses symbol) → 2 entries.
    expect(cache.size).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────
// Exported ground-truth table
// ──────────────────────────────────────────────────────────────────

describe('NATIVE_USDC_DECIMALS', () => {
  it('contains the known native-USDC chains, all at 6', () => {
    for (const chain of ['arc', 'arc-testnet', 'base', 'base-sepolia', 'avalanche', 'avalanche-fuji', 'ethereum', 'ethereum-sepolia']) {
      expect(NATIVE_USDC_DECIMALS[chain]).toBe(6);
    }
  });

  it('is frozen — cannot be mutated by consumers', () => {
    expect(Object.isFrozen(NATIVE_USDC_DECIMALS)).toBe(true);
  });
});
