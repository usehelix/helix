import type { GeneCapsule } from './types.js';

// Seed capsules = STARTING priors for a fresh Gene Map, not observed history.
// successCount AND avgRepairMs reflect REAL observations only: both are 0 unless
// a capsule is backed by a concrete bench/telemetry artifact (see per-capsule
// notes). A non-zero successCount claims N real repairs succeeded, and a non-zero
// avgRepairMs claims a measured repair latency — we only make those claims where
// an artifact exists. (qValue may still carry a measured prior, e.g. 0.76, even
// when successCount=0: the q came from a bench, no live repairs are recorded yet.)
export const SEED_GENES: Omit<GeneCapsule, 'id'>[] = [
  // ── Generic platform priors (tempo / privy / coinbase) ──
  // Hand-seeded. q-values are unvalidated priors; successCount zeroed (no artifact).
  { failureCode: 'nonce-mismatch', category: 'nonce', strategy: 'refresh_nonce', params: {}, successCount: 0, avgRepairMs: 180, platforms: ['tempo', 'privy', 'coinbase'], qValue: 0.85, consecutiveFailures: 0 },
  { failureCode: 'verification-failed', category: 'signature', strategy: 'refresh_nonce', params: {}, successCount: 0, avgRepairMs: 300, platforms: ['coinbase', 'privy'], qValue: 0.7, consecutiveFailures: 0 },
  { failureCode: 'payment-insufficient', category: 'balance', strategy: 'reduce_request', params: {}, successCount: 0, avgRepairMs: 45, platforms: ['tempo', 'privy', 'coinbase'], qValue: 0.82, consecutiveFailures: 0 },
  { failureCode: 'rate-limited', category: 'auth', strategy: 'backoff_retry', params: { defaultDelayMs: 2000 }, successCount: 0, avgRepairMs: 2100, platforms: ['generic', 'coinbase'], qValue: 0.88, consecutiveFailures: 0 },
  { failureCode: 'token-uninitialized', category: 'network', strategy: 'switch_network', params: {}, successCount: 0, avgRepairMs: 210, platforms: ['tempo', 'privy', 'coinbase'], qValue: 0.80, consecutiveFailures: 0 },
  { failureCode: 'server-error', category: 'service', strategy: 'retry', params: {}, successCount: 0, avgRepairMs: 500, platforms: ['generic', 'coinbase', 'tempo'], qValue: 0.78, consecutiveFailures: 0 },
  { failureCode: 'timeout', category: 'service', strategy: 'backoff_retry', params: { defaultDelayMs: 3000 }, successCount: 0, avgRepairMs: 3200, platforms: ['generic', 'coinbase'], qValue: 0.75, consecutiveFailures: 0 },
  { failureCode: 'policy-violation', category: 'policy', strategy: 'split_transaction', params: {}, successCount: 0, avgRepairMs: 520, platforms: ['privy', 'coinbase'], qValue: 0.76, consecutiveFailures: 0 },
  { failureCode: 'invalid-challenge', category: 'session', strategy: 'renew_session', params: {}, successCount: 0, avgRepairMs: 150, platforms: ['tempo'], qValue: 0.82, consecutiveFailures: 0 },
  { failureCode: 'malformed-credential', category: 'service', strategy: 'fix_params', params: {}, successCount: 0, avgRepairMs: 50, platforms: ['privy', 'coinbase'], qValue: 0.80, consecutiveFailures: 0 },
  { failureCode: 'tip-403', category: 'compliance', strategy: 'switch_stablecoin', params: {}, successCount: 0, avgRepairMs: 800, platforms: ['tempo'], qValue: 0.72, consecutiveFailures: 0 },
  { failureCode: 'swap-reverted', category: 'dex', strategy: 'split_swap', params: { defaultChunks: 3 }, successCount: 0, avgRepairMs: 3500, platforms: ['tempo'], qValue: 0.68, consecutiveFailures: 0 },
  { failureCode: 'tx-reverted', category: 'batch', strategy: 'remove_and_resubmit', params: {}, successCount: 0, avgRepairMs: 450, platforms: ['tempo', 'coinbase'], qValue: 0.74, consecutiveFailures: 0 },

  // ── Circle capsules ──
  // apiLayer is REQUIRED for Gene Map UNIQUE(failure_code, category, COALESCE(api_layer, '')) — null != 'wallets-api'.

  // wallets-api-rate-limit: q=0.76 hand-seeded from Bench 2.1 (v1-vs-v2-rate-limit,
  // 5×20-concurrent Arc Testnet, measured 76% success). REAL bench measurement.
  // Caveat: serialize_and_backoff does NOT serialize cross-instance retries
  // (see scripts/circle-bench/results/v1-serialize-and-backoff-anomaly.md); 0.76
  // reflects measured load-degraded success, not the 0.95 ideal. successCount=0
  // and avgRepairMs=0: 0.76 is the measured prior, no live repairs recorded in
  // this map yet. (The 2000ms in params is the configured backoff delay, not a
  // measured repair latency — the bench reports per-trial wall-clock, not per-repair.)
  { failureCode: 'wallets-api-rate-limit', category: 'auth', apiLayer: 'wallets-api', strategy: 'serialize_and_backoff', params: { defaultDelayMs: 2000 }, successCount: 0, avgRepairMs: 0, platforms: ['circle'], qValue: 0.76, consecutiveFailures: 0 },

  // gateway-rate-limit: PRIOR SEED — strategy is structurally reasoned but NOT yet
  // validated by bench or telemetry. q-value is a conservative prior, not a measurement.
  { failureCode: 'gateway-rate-limit', category: 'auth', apiLayer: 'gateway', strategy: 'burst_then_pace', params: { burstSize: 10, pauseMs: 20000 }, successCount: 0, avgRepairMs: 0, platforms: ['circle'], qValue: 0.50, consecutiveFailures: 0 },

  // gateway-nonce-used: PRIOR SEED — strategy is structurally reasoned but NOT yet
  // validated by bench or telemetry. q-value is a conservative prior, not a measurement.
  { failureCode: 'gateway-nonce-used', category: 'signature', apiLayer: 'gateway', strategy: 'rotate_authorization', params: {}, successCount: 0, avgRepairMs: 0, platforms: ['circle'], qValue: 0.50, consecutiveFailures: 0 },

  // cctp-attestation-pending: PRIOR SEED — strategy is structurally reasoned but NOT yet
  // validated by bench or telemetry. q-value is a conservative prior, not a measurement.
  { failureCode: 'cctp-attestation-pending', category: 'service', apiLayer: 'cctp', strategy: 'wait_attestation', params: { pollIntervalMs: 5000, maxWaitMs: 90000 }, successCount: 0, avgRepairMs: 0, platforms: ['circle'], qValue: 0.50, consecutiveFailures: 0 },

  // circle-param-invalid: PRIOR SEED — strategy is structurally reasoned but NOT yet
  // validated by bench or telemetry. q-value is a conservative prior, not a measurement.
  { failureCode: 'circle-param-invalid', category: 'auth', apiLayer: 'wallets-api', strategy: 'hold_and_notify', params: {}, successCount: 0, avgRepairMs: 0, platforms: ['circle'], qValue: 0.50, consecutiveFailures: 0 },

  // decimals-metadata-mismatch: PRIOR SEED — strategy is structurally reasoned but NOT yet
  // validated by bench or telemetry. q-value is a conservative prior, not a measurement.
  // (One live-tx observation exists — Exp A, n=1 — insufficient to validate a q-value.)
  { failureCode: 'decimals-metadata-mismatch', category: 'infrastructure', apiLayer: 'wallets-api', strategy: 'override_api_decimals', params: {}, successCount: 0, avgRepairMs: 0, platforms: ['circle'], qValue: 0.50, consecutiveFailures: 0 },

  // stale_quote: REAL telemetry — Exp D, 48/50 (96% E2E) across 932 Arc Testnet tx
  // (artifact: scripts/circle-bench/charts/summary.md + runs/manifest-*.json all_tx_hashes).
  // Strategy 'observe' = capsule RECORDS the failure only; it does NOT execute a repair.
  // The 96% reflects downstream workflow reordering by the agent's preflight hook reading
  // this capsule's audit log, not an in-engine repair. successCount=48 = real observed count.
  { failureCode: 'stale_quote', category: 'service', apiLayer: 'wallets-api', strategy: 'observe', params: { bench_validation: 'Exp D: 48/50 success (96% E2E) across 932 Arc Testnet tx', reorder_recommendation_when_think_independent: 'think → discover → estimate → pay → verify', alternative_when_think_consumes_quote: 'split think into pre-quote (selection) and post-quote (price-check) halves', additional_options: ['request longer quote TTL from facilitator', 'refresh quote with quick second discover before pay'], caveat: 'late_discover is valid only when think does NOT consume the quote. If think reads quote.price or quote.expires_at, agent must split think or use one of the alternative options.' }, successCount: 48, avgRepairMs: 30, platforms: ['circle'], qValue: 0.96, consecutiveFailures: 0 },
];
