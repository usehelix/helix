/**
 * @file metadata-trust.ts
 * @description v2 strategy for `decimals-metadata-mismatch` (generalized).
 *
 * v1 `override_api_decimals` only checks DECIMALS. This v2 strategy verifies
 * the full token metadata triple (decimals, symbol, address) against on-chain
 * ground truth where possible, and falls back to a curated table of known
 * native-USDC chains where on-chain ERC-20 calls don't apply.
 *
 * Priority order:
 *   1. On-chain ERC-20 `readContract` — only if publicClient AND address
 *      AND !isNative. Reads decimals() AND symbol() to catch BOTH classes
 *      of metadata bug.
 *   2. Ground-truth table — for native USDC on known chains
 *      (Arc, Base, Avalanche, Ethereum and their testnets). Same value
 *      everywhere (6); table is here mainly so the source-of-truth shows
 *      up in audit / explanation output.
 *   3. API-trusted — return as-is, source='api-trusted', no discrepancies.
 *
 * Caching:
 *   Pass a Map<string, MetadataTrustResult> via options.cache and identical
 *   token-on-chain lookups will return the cached result without re-querying
 *   either the chain or the table. Cache key includes the chain so the same
 *   USDC symbol on two different chains stays separate.
 *
 * STANDALONE — not integrated into the PCEC engine. Bench scripts call this
 * function directly to compare against v1 `override_api_decimals`.
 */

import type { PublicClient } from 'viem';

// ──────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────

export interface TokenMetadata {
  decimals: number;
  symbol?: string;
  address?: string;
  /** True for chains where the asset is the native gas/value token
   *  (e.g. Arc Testnet's USDC). On-chain ERC-20 calls don't apply. */
  isNative?: boolean;
}

export interface MetadataTrustResult {
  /** True if no discrepancies were detected (or no source could be checked). */
  trusted: boolean;
  /** The corrected metadata. Equals apiReported when trusted=true. */
  verified: TokenMetadata;
  /** The original API claim, preserved for diagnostics. */
  apiReported: TokenMetadata;
  /** Human-readable list of differences between API and verified source. */
  discrepancies: string[];
  /** Where the verification came from. */
  source: 'on-chain' | 'ground-truth-table' | 'api-trusted';
}

export interface VerifyTokenMetadataOptions {
  publicClient?: PublicClient;
  /** Chain identifier — used by ground-truth lookup and cache keying.
   *  E.g. 'arc-testnet', 'base-sepolia'. Case-insensitive. */
  chain?: string;
  /** Optional shared cache. Same instance can be reused across calls. */
  cache?: Map<string, MetadataTrustResult>;
}

// ──────────────────────────────────────────────────────────────────────
// Ground-truth table — known native-USDC chains
// ──────────────────────────────────────────────────────────────────────

/**
 * Chains where USDC is native (no ERC-20 contract to query). All entries
 * use the canonical 6 decimals; Circle's API metadata sometimes reports 18
 * for these (Exp A on Arc Testnet, verified May 2026).
 *
 * Keys are lowercased chain identifiers.
 */
export const NATIVE_USDC_DECIMALS: Readonly<Record<string, number>> = Object.freeze({
  'arc-testnet': 6,
  'arc': 6,
  'base-sepolia': 6,
  'base': 6,
  'avalanche-fuji': 6,
  'avalanche': 6,
  'ethereum': 6,
  'ethereum-sepolia': 6,
});

// ──────────────────────────────────────────────────────────────────────
// ABI fragments for the two ERC-20 calls we make
// ──────────────────────────────────────────────────────────────────────

const ERC20_DECIMALS_ABI = [{
  name: 'decimals',
  type: 'function',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'uint8' }],
}] as const;

const ERC20_SYMBOL_ABI = [{
  name: 'symbol',
  type: 'function',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'string' }],
}] as const;

// ──────────────────────────────────────────────────────────────────────
// Cache key — chain + (address ?? symbol ?? '')
// ──────────────────────────────────────────────────────────────────────

function cacheKey(meta: TokenMetadata, chain?: string): string {
  const identifier = meta.address ?? meta.symbol ?? '';
  return `${(chain ?? '').toLowerCase()}:${identifier.toLowerCase()}`;
}

// ──────────────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────────────

export async function verifyTokenMetadata(
  apiMetadata: TokenMetadata,
  options: VerifyTokenMetadataOptions = {},
): Promise<MetadataTrustResult> {
  const { publicClient, chain, cache } = options;
  const key = cacheKey(apiMetadata, chain);

  if (cache && cache.has(key)) {
    return cache.get(key)!;
  }

  const discrepancies: string[] = [];
  const verified: TokenMetadata = { ...apiMetadata };
  let source: MetadataTrustResult['source'] = 'api-trusted';

  // ── PRIORITY 1: On-chain ERC-20 ──────────────────────────────────
  if (publicClient && apiMetadata.address && !apiMetadata.isNative) {
    try {
      const onChainDecimals = (await publicClient.readContract({
        address: apiMetadata.address as `0x${string}`,
        abi: ERC20_DECIMALS_ABI,
        functionName: 'decimals',
      })) as number;

      let onChainSymbol: string | undefined;
      try {
        onChainSymbol = (await publicClient.readContract({
          address: apiMetadata.address as `0x${string}`,
          abi: ERC20_SYMBOL_ABI,
          functionName: 'symbol',
        })) as string;
      } catch {
        // symbol() is optional on some legacy ERC-20s — don't fail the whole
        // verification if only this call throws.
        onChainSymbol = undefined;
      }

      if (onChainDecimals !== apiMetadata.decimals) {
        discrepancies.push(
          `decimals: API=${apiMetadata.decimals}, on-chain=${onChainDecimals}`,
        );
        verified.decimals = onChainDecimals;
      }
      if (onChainSymbol !== undefined && apiMetadata.symbol !== undefined
          && onChainSymbol !== apiMetadata.symbol) {
        discrepancies.push(
          `symbol: API="${apiMetadata.symbol}", on-chain="${onChainSymbol}"`,
        );
        verified.symbol = onChainSymbol;
      }

      source = 'on-chain';
    } catch {
      // readContract failed — fall through to ground-truth table.
    }
  }

  // ── PRIORITY 2: Ground-truth table for native USDC ───────────────
  if (source === 'api-trusted' && chain && apiMetadata.symbol?.toUpperCase() === 'USDC') {
    const groundTruthDecimals = NATIVE_USDC_DECIMALS[chain.toLowerCase()];
    if (groundTruthDecimals !== undefined && groundTruthDecimals !== apiMetadata.decimals) {
      discrepancies.push(
        `decimals: API=${apiMetadata.decimals}, known-correct=${groundTruthDecimals}`,
      );
      verified.decimals = groundTruthDecimals;
      source = 'ground-truth-table';
    } else if (groundTruthDecimals !== undefined) {
      // Chain matched, API agreed — promote source so the result shows
      // we DID verify (not just "no source available").
      source = 'ground-truth-table';
    }
  }

  // ── PRIORITY 3: API-trusted (implicit — source stays 'api-trusted') ──

  const result: MetadataTrustResult = {
    trusted: discrepancies.length === 0,
    verified,
    apiReported: apiMetadata,
    discrepancies,
    source,
  };

  cache?.set(key, result);
  return result;
}
