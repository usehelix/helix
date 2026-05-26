/**
 * Circle Platform — Repair Strategies
 *
 * Maps Circle-specific failure codes to repair candidates.
 * Pairs with packages/core/src/platforms/circle/perceive.ts.
 *
 * IMPORTANT — Circle has THREE distinct API layers, each with its own
 * throttle/error model. The same-looking "rate limit" error needs a
 * DIFFERENT strategy depending on which layer:
 *
 *   Wallets API (api.circle.com/v1/w3s)
 *     → concurrency lock model: multiple parallel ops on same wallet are
 *       serialized server-side, excess returns 429
 *     → fix: serialize_and_backoff (don't parallelize, retry with delay)
 *
 *   Gateway (gateway-api.circle.com)
 *     → throughput window model: sustained rate is throttled,
 *       short bursts are OK
 *     → fix: burst_then_pace (batch of N, then pause)
 *
 *   CCTP (TokenMessenger / MessageTransmitter contracts + attestation API)
 *     → attestation-async model: burn is fast, but Circle attestation
 *       service takes 10-90s to produce attestation before mint can happen
 *     → fix: wait_attestation (poll attestation API)
 *
 * These distinctions were validated in Nanopayments Exp A2 / C2 (Apr 2026).
 * Using serialize_and_backoff on Gateway makes things WORSE (it's a
 * throughput window, not a concurrency lock).
 *
 * The api_layer field on FailureClassification (set by perceive.ts) is
 * what routes the failure to the correct strategy here.
 *
 * In addition to the 4 telemetry-validated strategies above, this adapter
 * also recognizes 12 Web SDK numeric error codes documented at
 * developers.circle.com/wallets/user-controlled/web-sdk and routes each to
 * an EXISTING engine strategy (no new strategies introduced for these).
 */

import type {
  PlatformAdapter,
  RepairCandidate,
  FailureClassification,
} from '../../engine/types.js';

import { circlePerceive } from './perceive.js';

// ──────────────────────────────────────────────────────────────────
// Construct: failure → candidates
// ──────────────────────────────────────────────────────────────────

function construct(failure: FailureClassification): RepairCandidate[] {
  const candidates: RepairCandidate[] = [];

  // ════════════════════════════════════════════════════════════════
  // Group 1 — Telemetry-validated Circle-specific strategies
  // (Nanopayments Exp A2/C2, April 2026 — q-values are real)
  // ════════════════════════════════════════════════════════════════

  // ─── Wallets API rate limit ─────────────────────────────────────
  // Validated: q=0.95 in Helix telemetry registry
  // Root cause: concurrency lock on wallet entity
  if (failure.code === 'wallets-api-rate-limit') {
    candidates.push({
      id: 'circle_serialize_walletsapi',
      strategy: 'serialize_and_backoff',
      description:
        'Wallets API serializes ops on same wallet — switch to sequential calls with backoff',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 2500,
      requirements: [],
      score: 0,
      successProbability: 0.95,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Circle Wallets API uses concurrency locks per wallet entity. Parallel requests get 429. ' +
        'Serializing requests and adding backoff between retries resolves this reliably.',
    });
  }

  // ─── Gateway rate limit ─────────────────────────────────────────
  // Validated: q=0.70 in Helix telemetry registry
  // Root cause: sliding-window throughput limit
  if (failure.code === 'gateway-rate-limit') {
    candidates.push({
      id: 'circle_burst_pace_gateway',
      strategy: 'burst_then_pace',
      description:
        'Gateway throughput window — send batch of 10, then pause 20s',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 20000,
      requirements: [],
      score: 0,
      successProbability: 0.7,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Circle Gateway uses sliding-window rate limiting on throughput. ' +
        'Bursting 10 requests then pausing 20s respects the window without serializing.',
    });
  }

  // ─── Gateway nonce reused (EIP-3009) ────────────────────────────
  // Root cause: transferWithAuthorization requires unique nonce per
  // (from, nonce) tuple. Reusing a nonce that has been used or revoked
  // by cancelAuthorization fails the signature check on chain.
  if (failure.code === 'gateway-nonce-used') {
    candidates.push({
      id: 'circle_rotate_auth',
      strategy: 'rotate_authorization',
      description:
        'Generate fresh EIP-3009 authorization with new unique nonce + signature',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 200,
      requirements: ['signer'],
      score: 0,
      successProbability: 0.92,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'EIP-3009 transferWithAuthorization checks nonce uniqueness per from-address. ' +
        'Rotating to a fresh 32-byte random nonce and re-signing always resolves.',
    });
  }

  // ─── CCTP attestation pending ───────────────────────────────────
  // Root cause: Circle attestation service has not yet signed the
  // burn event. Burn happened on source chain but mint cannot proceed
  // until attestation is available.
  if (failure.code === 'cctp-attestation-pending') {
    candidates.push({
      id: 'circle_wait_attestation',
      strategy: 'wait_attestation',
      description:
        'Poll Circle attestation API until attestation is ready, then retry mint',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 30000,
      requirements: ['messageHash'],
      score: 0,
      successProbability: 0.98,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'CCTP attestations are produced asynchronously after the burn event. ' +
        'Polling iam-api.circle.com/v1/attestations/{messageHash} until status=complete ' +
        'is the canonical pattern documented by Circle.',
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Group 2 — Web SDK numeric-code-mapped failures
  // Each routes to an EXISTING engine strategy (no new ones added).
  // successProbability values are conservative defaults (not yet
  // experimentally validated like Group 1).
  // ════════════════════════════════════════════════════════════════

  // code === 1 — missing required parameter
  if (failure.code === 'circle-param-missing') {
    candidates.push({
      id: 'circle_param_missing_notify',
      strategy: 'hold_and_notify',
      description: 'Required parameter missing — surface to caller for fix',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 60000,
      requirements: [],
      score: 0,
      successProbability: 0.4,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Code=1 indicates a missing required field. Helix cannot synthesize the missing value — ' +
        'route to operator-in-loop for inspection.',
    });
  }

  // code === 2 — invalid parameter
  if (failure.code === 'circle-param-invalid') {
    candidates.push({
      id: 'circle_param_invalid_notify',
      strategy: 'hold_and_notify',
      description: 'Invalid parameter value — surface to caller for fix',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 60000,
      requirements: [],
      score: 0,
      successProbability: 0.4,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Code=2 indicates a malformed parameter. Without schema introspection we cannot ' +
        'auto-repair — route to operator.',
    });
  }

  // code === 3 — forbidden (action not allowed for this entity)
  if (failure.code === 'circle-forbidden') {
    candidates.push({
      id: 'circle_forbidden_notify',
      strategy: 'hold_and_notify',
      description: 'Action forbidden — policy/permission issue',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 60000,
      requirements: [],
      score: 0,
      successProbability: 0.3,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Code=3 indicates the entity is not authorized for this action. ' +
        'Requires manual permission grant — not auto-repairable.',
    });
  }

  // code === 4 — unauthorized (auth token issue)
  if (failure.code === 'circle-unauthorized') {
    candidates.push({
      id: 'circle_unauthorized_renew',
      strategy: 'renew_session',
      description: 'Auth token rejected — renew Circle session',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 500,
      requirements: ['sessionRefresher'],
      score: 0,
      successProbability: 0.8,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Code=4 is most commonly an expired or revoked auth token. Re-acquiring credentials ' +
        'and retrying usually resolves.',
    });
  }

  // code === 9 — generic retry hint
  if (failure.code === 'circle-retry') {
    candidates.push({
      id: 'circle_retry_backoff',
      strategy: 'backoff_retry',
      description: 'Circle returned retry hint — back off and try again',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 2000,
      requirements: [],
      score: 0,
      successProbability: 0.7,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Code=9 is Circle\'s "transient, try again" signal. Standard exponential backoff applies.',
    });
  }

  // code === 10 — customer suspended
  if (failure.code === 'circle-customer-suspended') {
    candidates.push({
      id: 'circle_suspended_notify',
      strategy: 'hold_and_notify',
      description: 'Customer account suspended — escalate, do not retry',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 60000,
      requirements: [],
      score: 0,
      successProbability: 0.1,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Code=10 indicates an account-level suspension. Retrying will only repeat the failure; ' +
        'escalate to compliance.',
    });
  }

  // code === 11 — pending (result not yet available)
  if (failure.code === 'circle-pending') {
    candidates.push({
      id: 'circle_pending_receipt',
      strategy: 'retry_with_receipt',
      description: 'Resource pending — poll with receipt-based retry',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 1500,
      requirements: [],
      score: 0,
      successProbability: 0.75,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Code=11 says the operation is still settling. Retrying with the existing receipt/id ' +
        'avoids creating a duplicate request.',
    });
  }

  // code === 155104 — auth token expired
  if (failure.code === 'circle-token-expired') {
    candidates.push({
      id: 'circle_token_expired_renew',
      strategy: 'renew_session',
      description: 'Wallet auth token expired — renew',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 500,
      requirements: ['sessionRefresher'],
      score: 0,
      successProbability: 0.85,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Code=155104 is the explicit token-expired signal on Wallets API. Renew and retry.',
    });
  }

  // code === 155201 — wallet has insufficient funds
  if (failure.code === 'circle-insufficient-funds') {
    candidates.push({
      id: 'circle_insufficient_reduce',
      strategy: 'reduce_request',
      description: 'Insufficient funds — reduce amount and retry',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 100,
      requirements: ['amount'],
      score: 0,
      successProbability: 0.7,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Code=155201 means the wallet balance < request. Either reduce to available balance or ' +
        'caller must top up — reduce_request lets the engine try the reduced amount first.',
    });
  }

  // code === 155203 — single-tx withdraw limit exceeded
  if (failure.code === 'circle-exceed-withdraw-limit') {
    candidates.push({
      id: 'circle_limit_split',
      strategy: 'split_transaction',
      description: 'Per-tx withdraw limit exceeded — split into smaller batches',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 500,
      requirements: ['amount'],
      score: 0,
      successProbability: 0.7,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Code=155203 hits Circle\'s per-tx withdrawal ceiling. Splitting the transfer keeps each ' +
        'leg under the limit.',
    });
  }

  // code === 155264 — wallet's pending-tx queue is full
  if (failure.code === 'circle-pending-tx-queue-full') {
    candidates.push({
      id: 'circle_queue_full_cancel',
      strategy: 'cancel_pending_txs',
      description: 'Wallet queue saturated — cancel stuck txs first',
      estimatedCostUsd: 0,
      estimatedSpeedMs: 3000,
      requirements: ['walletId'],
      score: 0,
      successProbability: 0.6,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Code=155264 means the wallet has too many pending txs and won\'t accept more. ' +
        'Cancelling unconfirmed entries frees the queue.',
    });
  }

  return candidates;
}

// ──────────────────────────────────────────────────────────────────
// Adapter export
// ──────────────────────────────────────────────────────────────────

export const circleAdapter: PlatformAdapter = {
  name: 'circle',
  perceive: circlePerceive,
  construct,
};
