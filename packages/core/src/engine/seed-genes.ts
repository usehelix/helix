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
  // HONESTY (2.8.1 audit): these were hand-seeded priors of 0.68–0.88 with NO
  // supporting artifact (successCount=0). Detection is unit-tested for some
  // (nonce-mismatch, rate-limited, server-error, timeout); REPAIR is validated
  // for none — no real call→error→repair→success was ever measured. A high
  // "prior" reads to users as measured confidence, so all are normalized to a
  // neutral 0.50. They re-climb only on real Q-learning rewards from live traffic.
  { failureCode: 'nonce-mismatch', category: 'nonce', strategy: 'refresh_nonce', params: {}, successCount: 0, avgRepairMs: 180, platforms: ['tempo', 'privy', 'coinbase'], qValue: 0.50, consecutiveFailures: 0 },
  { failureCode: 'verification-failed', category: 'signature', strategy: 'refresh_nonce', params: {}, successCount: 0, avgRepairMs: 300, platforms: ['coinbase', 'privy'], qValue: 0.50, consecutiveFailures: 0 },
  // NON-REPAIRABLE. detection: validated (insufficient-balance classification
  // is unit-tested — see error-embedding.test.ts). repair: non-applicable —
  // Helix cannot create funds; hold_and_notify is the correct HALT, not a
  // recovery. qValue is a neutral prior (halt-confidence), NOT a repair-success
  // probability — was an unvalidated 0.82 in 2.8.0, demoted here. reduce_request
  // fires only via a context-aware adapter construct when allowPartial:true.
  { failureCode: 'payment-insufficient', category: 'balance', strategy: 'hold_and_notify', params: {}, successCount: 0, avgRepairMs: 0, platforms: ['tempo', 'privy', 'coinbase'], qValue: 0.50, nonRepairable: true, consecutiveFailures: 0 },
  { failureCode: 'rate-limited', category: 'auth', strategy: 'backoff_retry', params: { defaultDelayMs: 2000 }, successCount: 0, avgRepairMs: 2100, platforms: ['generic', 'coinbase'], qValue: 0.50, consecutiveFailures: 0 },
  { failureCode: 'token-uninitialized', category: 'network', strategy: 'switch_network', params: {}, successCount: 0, avgRepairMs: 210, platforms: ['tempo', 'privy', 'coinbase'], qValue: 0.50, consecutiveFailures: 0 },
  { failureCode: 'server-error', category: 'service', strategy: 'retry', params: {}, successCount: 0, avgRepairMs: 500, platforms: ['generic', 'coinbase', 'tempo'], qValue: 0.50, consecutiveFailures: 0 },
  { failureCode: 'timeout', category: 'service', strategy: 'backoff_retry', params: { defaultDelayMs: 3000 }, successCount: 0, avgRepairMs: 3200, platforms: ['generic', 'coinbase'], qValue: 0.50, consecutiveFailures: 0 },
  { failureCode: 'policy-violation', category: 'policy', strategy: 'split_transaction', params: {}, successCount: 0, avgRepairMs: 520, platforms: ['privy', 'coinbase'], qValue: 0.50, consecutiveFailures: 0 },
  { failureCode: 'invalid-challenge', category: 'session', strategy: 'renew_session', params: {}, successCount: 0, avgRepairMs: 150, platforms: ['tempo'], qValue: 0.50, consecutiveFailures: 0 },
  { failureCode: 'malformed-credential', category: 'service', strategy: 'fix_params', params: {}, successCount: 0, avgRepairMs: 50, platforms: ['privy', 'coinbase'], qValue: 0.50, consecutiveFailures: 0 },
  { failureCode: 'tip-403', category: 'compliance', strategy: 'switch_stablecoin', params: {}, successCount: 0, avgRepairMs: 800, platforms: ['tempo'], qValue: 0.50, consecutiveFailures: 0 },
  { failureCode: 'swap-reverted', category: 'dex', strategy: 'split_swap', params: { defaultChunks: 3 }, successCount: 0, avgRepairMs: 3500, platforms: ['tempo'], qValue: 0.50, consecutiveFailures: 0 },
  { failureCode: 'tx-reverted', category: 'batch', strategy: 'remove_and_resubmit', params: {}, successCount: 0, avgRepairMs: 450, platforms: ['tempo', 'coinbase'], qValue: 0.50, consecutiveFailures: 0 },

  // ── Circle capsules ──
  // apiLayer is REQUIRED for Gene Map UNIQUE(failure_code, category, COALESCE(api_layer, '')) — null != 'wallets-api'.

  // wallets-api-rate-limit: DETECTION-VALIDATED ONLY (2.8.1 audit). Demoted
  // 0.76 → 0.50. The Bench 2.1 "76%" (v1-vs-v2-rate-limit.ts) counts FULFILLED
  // createTransaction promises (API-accepted, NOT on-chain-settled — no
  // getTransaction poll) and is the ambient FIRST-ATTEMPT acceptance rate: the
  // ~5/20 calls that hit 429 engaged serialize_and_backoff, retried, and ALL
  // hit 429 again ("permanently lost" — see results/v1-serialize-and-backoff-
  // anomaly.md). The repair recovered ~0% at 20-concurrent, so 0.76 was NOT a
  // repair-success rate.
  //
  // ⚠️ KNOWN-BROKEN STRATEGY — DO NOT re-validate without fixing first:
  // serialize_and_backoff does NOT serialize. It sets _helix_serialize /
  // _helix_concurrency overrides that NO caller reads, then retries in
  // parallel. Effective fix (per-wallet semaphore / true serialization) is
  // tracked for PR #4 alongside the v2 chunk_concurrent migration.
  { failureCode: 'wallets-api-rate-limit', category: 'auth', apiLayer: 'wallets-api', strategy: 'serialize_and_backoff', params: { defaultDelayMs: 2000 }, successCount: 0, avgRepairMs: 0, platforms: ['circle'], qValue: 0.50, consecutiveFailures: 0 },

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
