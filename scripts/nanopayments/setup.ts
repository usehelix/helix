/**
 * Nanopayments Setup
 *
 * 1. Generate buyer + seller wallets (if not yet present)
 * 2. Check Gateway balance
 * 3. If balance < $1, deposit $2 USDC into Gateway
 *
 * Run once; no-op on subsequent runs if Gateway is already funded.
 *
 * Usage:
 *   npx tsx --env-file=../circle-bench/.env scripts/nanopayments/setup.ts
 */

import { GatewayClient } from '@circle-fin/x402-batching/client';

const BUYER_PRIVATE_KEY = process.env.NANOPAY_BUYER_KEY;
const CHAIN = 'arcTestnet' as const;

async function main() {
  if (!BUYER_PRIVATE_KEY) {
    throw new Error('Missing NANOPAY_BUYER_KEY in .env');
  }

  const client = new GatewayClient({
    chain: CHAIN,
    privateKey: BUYER_PRIVATE_KEY as `0x${string}`,
  });

  const balances = await client.getBalances();
  console.log('Gateway available:', balances.gateway.formattedAvailable, 'USDC');
  console.log('Wallet USDC:      ', balances.wallet.formatted, 'USDC');

  const available = parseFloat(balances.gateway.formattedAvailable ?? '0');
  if (available < 1.0) {
    console.log('\nDepositing $2 USDC into Gateway...');
    const deposit = await client.deposit('2');
    console.log('Deposit tx:', deposit.depositTxHash);
    console.log('Done. Gateway funded.');
  } else {
    console.log('\nGateway balance sufficient. Ready.');
  }
}

main().catch(err => {
  console.error('Fatal:', err?.message ?? err);
  process.exit(1);
});
