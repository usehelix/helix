/**
 * x402 Nanopayment Seller
 *
 * Protects GET /item; requires $0.001 USDC to access.
 * Uses Circle Gateway middleware to verify EIP-3009 signatures.
 *
 * Usage:
 *   npx tsx --env-file=../circle-bench/.env seller-server.ts
 * Port: 4021
 */

import express from 'express';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';

const SELLER_ADDRESS = process.env.NANOPAY_SELLER_ADDRESS as `0x${string}` | undefined;
const PORT = 4021;

if (!SELLER_ADDRESS) {
  console.error('Missing NANOPAY_SELLER_ADDRESS in .env');
  process.exit(1);
}

const app = express();
const gateway = createGatewayMiddleware({
  sellerAddress: SELLER_ADDRESS,
  networks: ['eip155:5042002'], // Arc Testnet only
});

app.get('/item', gateway.require('$0.001'), (_req, res) => {
  res.json({
    success: true,
    item: { id: `item-${Date.now()}`, content: 'DATA_UNIT' },
    payment_received: true,
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, seller: SELLER_ADDRESS, price: '$0.001' });
});

app.listen(PORT, () => {
  console.log(`x402 Seller running on port ${PORT}`);
  console.log(`Seller address: ${SELLER_ADDRESS}`);
  console.log(`Protected endpoint: http://localhost:${PORT}/item`);
});
