/**
 * Chain configuration registry.
 *
 * Currently only `arc-testnet` is implemented. The seam exists so that a
 * second chain can be added without refactoring runner / circle-client /
 * seller-client. To add a chain: append to CHAIN_CONFIGS and ensure the
 * Circle SDK supports the blockchain identifier.
 */

export interface ChainConfig {
  /** Key used by --chain CLI flag and registry lookup */
  key: string;
  /** Circle SDK blockchain identifier (passed to createWallets, etc.) */
  blockchain: string;
  /** Token symbol filtered out of getWalletTokenBalance for the payment step */
  tokenSymbol: string;
  /** Human display name */
  name: string;
  /** Block explorer URL prefix for tx_hash links */
  explorerTxPrefix: string;
}

export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  "arc-testnet": {
    key: "arc-testnet",
    blockchain: "ARC-TESTNET",
    tokenSymbol: "USDC",
    name: "Arc Testnet",
    explorerTxPrefix: "https://testnet.arcscan.app/tx/",
  },
};

export const DEFAULT_CHAIN_KEY = "arc-testnet";

export function getChainConfig(key: string = DEFAULT_CHAIN_KEY): ChainConfig {
  const c = CHAIN_CONFIGS[key];
  if (!c) {
    throw new Error(
      `Unknown chain "${key}". Known: ${Object.keys(CHAIN_CONFIGS).join(", ")}`,
    );
  }
  return c;
}
