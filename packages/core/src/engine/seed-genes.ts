import type { GeneCapsule } from './types.js';

export const SEED_GENES: Omit<GeneCapsule, 'id'>[] = [
  { failureCode: 'nonce-mismatch', category: 'nonce', strategy: 'refresh_nonce', params: {}, successCount: 10, avgRepairMs: 180, platforms: ['tempo', 'privy', 'coinbase'], qValue: 0.85, consecutiveFailures: 0 },
  { failureCode: 'verification-failed', category: 'signature', strategy: 'refresh_nonce', params: {}, successCount: 5, avgRepairMs: 300, platforms: ['coinbase', 'privy'], qValue: 0.7, consecutiveFailures: 0 },
  { failureCode: 'payment-insufficient', category: 'balance', strategy: 'reduce_request', params: {}, successCount: 8, avgRepairMs: 45, platforms: ['tempo', 'privy', 'coinbase'], qValue: 0.82, consecutiveFailures: 0 },
  { failureCode: 'rate-limited', category: 'auth', strategy: 'backoff_retry', params: { defaultDelayMs: 2000 }, successCount: 15, avgRepairMs: 2100, platforms: ['generic', 'coinbase'], qValue: 0.88, consecutiveFailures: 0 },
  { failureCode: 'token-uninitialized', category: 'network', strategy: 'switch_network', params: {}, successCount: 6, avgRepairMs: 210, platforms: ['tempo', 'privy', 'coinbase'], qValue: 0.80, consecutiveFailures: 0 },
  { failureCode: 'server-error', category: 'service', strategy: 'retry', params: {}, successCount: 12, avgRepairMs: 500, platforms: ['generic', 'coinbase', 'tempo'], qValue: 0.78, consecutiveFailures: 0 },
  { failureCode: 'timeout', category: 'service', strategy: 'backoff_retry', params: { defaultDelayMs: 3000 }, successCount: 10, avgRepairMs: 3200, platforms: ['generic', 'coinbase'], qValue: 0.75, consecutiveFailures: 0 },
  { failureCode: 'policy-violation', category: 'policy', strategy: 'split_transaction', params: {}, successCount: 5, avgRepairMs: 520, platforms: ['privy', 'coinbase'], qValue: 0.76, consecutiveFailures: 0 },
  { failureCode: 'invalid-challenge', category: 'session', strategy: 'renew_session', params: {}, successCount: 7, avgRepairMs: 150, platforms: ['tempo'], qValue: 0.82, consecutiveFailures: 0 },
  { failureCode: 'malformed-credential', category: 'service', strategy: 'fix_params', params: {}, successCount: 6, avgRepairMs: 50, platforms: ['privy', 'coinbase'], qValue: 0.80, consecutiveFailures: 0 },
  { failureCode: 'tip-403', category: 'compliance', strategy: 'switch_stablecoin', params: {}, successCount: 4, avgRepairMs: 800, platforms: ['tempo'], qValue: 0.72, consecutiveFailures: 0 },
  { failureCode: 'swap-reverted', category: 'dex', strategy: 'split_swap', params: { defaultChunks: 3 }, successCount: 3, avgRepairMs: 3500, platforms: ['tempo'], qValue: 0.68, consecutiveFailures: 0 },
  { failureCode: 'tx-reverted', category: 'batch', strategy: 'remove_and_resubmit', params: {}, successCount: 4, avgRepairMs: 450, platforms: ['tempo', 'coinbase'], qValue: 0.74, consecutiveFailures: 0 },
  // Circle (validated in Nanopayments Exp A2/C2, Apr 2026 — see project_circle_bench_data).
  // apiLayer is REQUIRED for Gene Map UNIQUE(failure_code, category, COALESCE(api_layer, '')) — null != 'wallets-api'.
  { failureCode: 'wallets-api-rate-limit', category: 'auth', apiLayer: 'wallets-api', strategy: 'serialize_and_backoff', params: { defaultDelayMs: 2000 }, successCount: 9, avgRepairMs: 2200, platforms: ['circle'], qValue: 0.95, consecutiveFailures: 0 },
  { failureCode: 'gateway-rate-limit', category: 'auth', apiLayer: 'gateway', strategy: 'burst_then_pace', params: { burstSize: 10, pauseMs: 20000 }, successCount: 7, avgRepairMs: 20500, platforms: ['circle'], qValue: 0.70, consecutiveFailures: 0 },
  { failureCode: 'gateway-nonce-used', category: 'signature', apiLayer: 'gateway', strategy: 'rotate_authorization', params: {}, successCount: 8, avgRepairMs: 250, platforms: ['circle'], qValue: 0.92, consecutiveFailures: 0 },
  { failureCode: 'cctp-attestation-pending', category: 'service', apiLayer: 'cctp', strategy: 'wait_attestation', params: { pollIntervalMs: 5000, maxWaitMs: 90000 }, successCount: 6, avgRepairMs: 32000, platforms: ['circle'], qValue: 0.98, consecutiveFailures: 0 },
  // Helix's deterministic answer for user-side param mistakes: don't retry, hand to operator.
  // qValue high (0.85) because hold_and_notify is the correct response to ANY param error.
  { failureCode: 'circle-param-invalid', category: 'auth', apiLayer: 'wallets-api', strategy: 'hold_and_notify', params: {}, successCount: 3, avgRepairMs: 5, platforms: ['circle'], qValue: 0.85, consecutiveFailures: 0 },
];
