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
 * These layer distinctions are a DESIGN model of which throttle mechanism
 * each Circle API uses — NOT a telemetry-validated result. Only the Wallets
 * API rate-limit behavior has a bench artifact (Bench 2.1, 5×20-concurrent
 * Arc Testnet); the Gateway and CCTP models are reasoned, not yet measured.
 * By this model, applying serialize_and_backoff to the Gateway throughput
 * window would be counterproductive (it's a window, not a concurrency lock).
 *
 * The api_layer field on FailureClassification (set by perceive.ts) is
 * what routes the failure to the correct strategy here.
 *
 * In addition to the 4 Circle-specific strategies above, this adapter
 * also recognizes 12 Web SDK numeric error codes documented at
 * developers.circle.com/wallets/user-controlled/web-sdk and routes each to
 * an EXISTING engine strategy (no new strategies introduced for these).
 */

import type {
  PlatformAdapter,
  RepairCandidate,
  FailureClassification,
  RepairContext,
} from '../../engine/types.js';

import { circlePerceive } from './perceive.js';

// ──────────────────────────────────────────────────────────────────
// Construct: failure → candidates
// ──────────────────────────────────────────────────────────────────

function construct(failure: FailureClassification, context?: RepairContext): RepairCandidate[] {
  const candidates: RepairCandidate[] = [];

  // ════════════════════════════════════════════════════════════════
  // Group 1 — Circle-specific strategies. successProbability values are
  // HAND-SEEDED starting points (see seed-genes.ts for per-capsule
  // provenance), NOT telemetry rollups.
  // ════════════════════════════════════════════════════════════════

  // ─── Wallets API rate limit ─────────────────────────────────────
  // DETECTION-VALIDATED ONLY (2.8.1 audit). successProbability 0.76 → 0.50 to
  // match seed-genes.ts. The Bench 2.1 "76%" was ambient first-attempt API
  // acceptance, not repair recovery (the repair recovered ~0% of 429s at
  // 20-concurrent). See seed-genes.ts for the full provenance.
  //
  // ⚠️ KNOWN-BROKEN STRATEGY: serialize_and_backoff does NOT serialize (the
  // _helix_serialize / _helix_concurrency overrides are never consumed). Do
  // NOT re-validate without fixing the underlying mechanism — tracked PR #4.
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
      successProbability: 0.50,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Circle Wallets API uses concurrency locks per wallet entity. Parallel requests get 429. ' +
        'DETECTION validated; REPAIR not validated — serialize_and_backoff is a no-op for ' +
        'serialization and recovered ~0% of rate-limited calls at 20-concurrent (Bench 2.1). ' +
        'Effective serialization tracked PR #4.',
    });
  }

  // ─── Gateway rate limit ─────────────────────────────────────────
  // PRIOR SEED — structurally reasoned (sliding-window throughput limit) but
  // NOT yet validated by bench or telemetry. successProbability is a prior.
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
      successProbability: 0.5,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'Circle Gateway uses sliding-window rate limiting on throughput. ' +
        'Bursting 10 requests then pausing 20s respects the window without serializing.',
    });
  }

  // ─── Gateway nonce reused (EIP-3009) ────────────────────────────
  // PRIOR SEED — structurally reasoned but NOT yet validated by bench or
  // telemetry. successProbability is a prior. Root cause:
  // transferWithAuthorization requires unique nonce per (from, nonce) tuple.
  // Reusing a nonce used/revoked by cancelAuthorization fails the on-chain
  // signature check.
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
      successProbability: 0.5,
      platform: 'circle',
      source: 'adapter',
      reasoning:
        'EIP-3009 transferWithAuthorization checks nonce uniqueness per from-address. ' +
        'Rotating to a fresh 32-byte random nonce and re-signing always resolves.',
    });
  }

  // ─── CCTP attestation pending ───────────────────────────────────
  // PRIOR SEED — structurally reasoned but NOT yet validated by bench or
  // telemetry. successProbability is a prior. Root cause: Circle attestation
  // service has not yet signed the burn event; mint cannot proceed until the
  // attestation is available.
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
      successProbability: 0.5,
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
      // 0.50 to match seed-genes.ts (detection ✓ / non-repair halt, not a prior claim).
      successProbability: 0.50,
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

  // code === 155201 / 155258 — wallet has insufficient funds
  //
  // DEFAULT: hold_and_notify. Silently reducing a fixed-obligation payment
  // (payroll, invoice) is INCORRECT — a contractor owed 10 must not receive 5.
  // The correct response to "not enough money" is to stop, alert the operator,
  // and let them top up. Helix cannot conjure funds, so this is not an
  // auto-repair — it is a safe halt.
  //
  // OPT-IN: reduce_request fires ONLY when the caller sets `allowPartial: true`
  // on the wrap config — meaningful for best-effort transfers (gas top-ups,
  // swap slippage) where a reduced amount is acceptable. Even then the L1
  // type-guard still refuses to corrupt non-scalar amounts.
  if (failure.code === 'circle-insufficient-funds') {
    if (context?.allowPartial === true) {
      candidates.push({
        id: 'circle_insufficient_reduce',
        strategy: 'reduce_request',
        description: 'Insufficient funds — reduce amount and retry (allowPartial)',
        estimatedCostUsd: 0,
        estimatedSpeedMs: 100,
        requirements: ['amount'],
        score: 0,
        successProbability: 0.7,
        platform: 'circle',
        source: 'adapter',
        reasoning:
          'Code=155201/155258: wallet balance < request, and the caller opted into partial ' +
          'payments (allowPartial). Reduce toward the available balance. Only valid for ' +
          'best-effort transfers — never for fixed obligations.',
      });
    } else {
      candidates.push({
        id: 'circle_insufficient_hold',
        strategy: 'hold_and_notify',
        description: 'Insufficient funds — halt and alert operator to top up',
        estimatedCostUsd: 0,
        estimatedSpeedMs: 60000,
        requirements: [],
        // NON-REPAIRABLE. detection: validated (155201/155258 probe-verified in
        // perceive.ts). repair: non-applicable — Helix cannot create funds, so
        // this is a HALT, not a recovery. successProbability here is the
        // confidence that halting is the correct response, NOT a repair-success
        // rate (was advertised as a 0.7 repair prior in 2.8.0; reclassified).
        score: 0,
        successProbability: 0.4,
        platform: 'circle',
        source: 'adapter',
        reasoning:
          'Code=155201/155258: wallet balance < request. This is NOT auto-repairable — Helix ' +
          'cannot create funds. Silently reducing a fixed-obligation payment would underpay. ' +
          'Correct behavior is to stop and notify the operator to top up. Set allowPartial:true ' +
          'only for best-effort transfers where a reduced amount is acceptable.',
      });
    }
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
