import type { FailureClassification, Platform } from '../../engine/types.js';

/**
 * Circle perceive — converts a Circle SDK / API error into a FailureClassification
 * with api_layer set so the Gene Map can pick the right strategy per layer.
 *
 * Circle exposes three meaningfully different APIs that share the failure surface
 * but need OPPOSITE repair strategies:
 *   - wallets-api  → concurrency-locked, fix via serialize_and_backoff
 *   - gateway      → throughput-windowed, fix via burst_then_pace
 *   - cctp         → cross-chain bridge, distinct error surface (TBD)
 *
 * The Gene Map's UNIQUE(failure_code, category, COALESCE(api_layer, '')) index
 * makes those three coexist as separate capsules with their own q_values.
 */

type ApiLayer = 'wallets-api' | 'gateway' | 'cctp' | null;

function detectApiLayer(error: any, context?: Record<string, unknown>): ApiLayer {
  // The URL lives in different fields depending on the Circle SDK version:
  //   v10+: top-level error.url (SDK wraps AxiosError into its own class)
  //   v7  : error.config.url / error.response.config.url (raw AxiosError)
  // Read both shapes; fall back to context, then message.
  const url = String(
    error?.url
      ?? error?.config?.url
      ?? error?.response?.config?.url
      ?? context?.url
      ?? context?.requestUrl
      ?? error?.message
      ?? ''
  );
  if (/api\.circle\.com\/v1\/w3s/i.test(url)) return 'wallets-api';
  if (/gateway-api(-testnet)?\.circle\.com/i.test(url)) return 'gateway';
  if (/x402-batching/i.test(url)) return 'gateway';
  if (/iris-api(-sandbox)?\.circle\.com/i.test(url)) return 'cctp';
  if (/TokenMessenger|MessageTransmitter|\bcctp\b/i.test(url)) return 'cctp';
  return null;
}

export function circlePerceive(error: Error, context?: Record<string, unknown>): FailureClassification | null {
  const platform: Platform = 'circle';
  const apiLayer = detectApiLayer(error, context);

  // The axios wrapper message (e.g. "Request failed with status code 429") —
  // kept as `msg` for the existing apiLayer-coupled regex blocks below that
  // assume this shape. New routing uses `circleMsg` instead.
  const msg = error.message;

  // Circle returns its numeric code in different places depending on SDK version:
  //   v10+: top-level error.code (number)  — SDK extracts it from response.data
  //   v7  : error.response.data.code        — raw axios shape
  // Only accept numeric values — that filters out axios's ERR_BAD_REQUEST (string)
  // which can appear at error.code in the v7 shape.
  const responseDataCode = (error as any)?.response?.data?.code;
  const topLevelCode = (error as any)?.code;
  const circleCode: number | undefined =
    typeof responseDataCode === 'number' ? responseDataCode :
    typeof topLevelCode === 'number' ? topLevelCode :
    undefined;

  // The actual Circle error message lives inside response.data.message.
  // Fall back to the axios wrapper message only if the Circle payload is missing.
  const circleMsg: string = String(
    (error as any)?.response?.data?.message ?? error?.message ?? ''
  );

  const base = { severity: 'medium' as const, platform, details: circleMsg, timestamp: Date.now() };

  // ════════════════════════════════════════════════════════════════════
  // Web SDK numeric error codes (developers.circle.com/wallets/.../web-sdk).
  // Source of truth: error.response.data.code (verified via probe).
  // Routed BEFORE the api_layer-specific blocks so any layer that reports a
  // canonical numeric code lands on the right capsule directly.
  // ════════════════════════════════════════════════════════════════════
  if (circleCode !== undefined) {
    if (circleCode === 1) {
      return { ...base, code: 'circle-param-missing', category: 'auth', severity: 'medium', apiLayer };
    }
    if (circleCode === 2) {
      return { ...base, code: 'circle-param-invalid', category: 'auth', severity: 'medium', apiLayer };
    }
    if (circleCode === 3) {
      return { ...base, code: 'circle-forbidden', category: 'auth', severity: 'high', apiLayer };
    }
    if (circleCode === 4) {
      return { ...base, code: 'circle-unauthorized', category: 'auth', severity: 'high', apiLayer };
    }
    if (circleCode === 5) {
      return { ...base, code: 'wallets-api-rate-limit', category: 'auth', severity: 'medium', apiLayer };
    }
    if (circleCode === 9) {
      return { ...base, code: 'circle-retry', category: 'service', severity: 'low', apiLayer };
    }
    if (circleCode === 10) {
      return { ...base, code: 'circle-customer-suspended', category: 'compliance', severity: 'critical', apiLayer };
    }
    if (circleCode === 11) {
      return { ...base, code: 'circle-pending', category: 'service', severity: 'low', apiLayer };
    }
    if (circleCode === 155104) {
      return { ...base, code: 'circle-token-expired', category: 'session', severity: 'medium', apiLayer };
    }
    // Circle returns 155258 in practice (probe-verified). The Web SDK enum
    // documents 155201 — accept both as aliases for forward-compat.
    if (circleCode === 155258 || circleCode === 155201) {
      return { ...base, code: 'circle-insufficient-funds', category: 'balance', severity: 'high', apiLayer };
    }
    if (circleCode === 155203) {
      return { ...base, code: 'circle-exceed-withdraw-limit', category: 'policy', severity: 'medium', apiLayer };
    }
    if (circleCode === 155264) {
      return { ...base, code: 'circle-pending-tx-queue-full', category: 'service', severity: 'medium', apiLayer };
    }
  }

  // Message-based fallbacks for cases where a numeric code isn't surfaced.
  // GATED on apiLayer !== null — i.e. only fire after detectApiLayer has
  // confirmed this is actually a Circle endpoint. Otherwise generic phrases
  // like "insufficient balance" would steal plain test errors from other
  // adapters in the chain.
  if (apiLayer !== null) {
    if (/api parameter missing/i.test(circleMsg)) {
      return { ...base, code: 'circle-param-missing', category: 'auth', severity: 'medium', apiLayer };
    }
    if (/api parameter invalid/i.test(circleMsg)) {
      return { ...base, code: 'circle-param-invalid', category: 'auth', severity: 'medium', apiLayer };
    }
    if (/insufficient.*(?:balance|funds|amount)|asset.*insufficient/i.test(circleMsg)) {
      return { ...base, code: 'circle-insufficient-funds', category: 'balance', severity: 'high', apiLayer };
    }
    if (/exceed.*withdraw/i.test(circleMsg)) {
      return { ...base, code: 'circle-exceed-withdraw-limit', category: 'policy', severity: 'medium', apiLayer };
    }
    if (/pending.*queue/i.test(circleMsg)) {
      return { ...base, code: 'circle-pending-tx-queue-full', category: 'service', severity: 'medium', apiLayer };
    }
    if (/token expired/i.test(circleMsg)) {
      return { ...base, code: 'circle-token-expired', category: 'session', severity: 'medium', apiLayer };
    }
  }

  // ── Wallets API (api.circle.com/v1/w3s) ──
  // Code-5 (wallets-api-rate-limit) is now handled in the numeric block above
  // regardless of apiLayer. The /insufficient|exceeds balance/i message check
  // is superseded by the broader insufficient-funds fallback above.
  // Block kept for documentation of historical Exp B findings.
  if (apiLayer === 'wallets-api') {
    /* Numeric/message routing above now handles wallets-api errors. */
  }

  // ── Gateway (gateway-api*.circle.com via @circle-fin/x402-batching) ──
  // Exp C: replays rejected with reason "nonce_already_used"
  // Exp A/B: rate-limit and settlement errors are all flattened to "Payment processing error"
  //   - by latency: <100ms = upstream gate reject (rate limit), ~290ms = settlement race
  if (apiLayer === 'gateway') {
    if (/nonce_already_used/i.test(msg)) {
      return { ...base, code: 'gateway-nonce-used', category: 'nonce', severity: 'medium', apiLayer };
    }
    if (/Payment failed:?\s*Payment (processing|settlement) error/i.test(msg) || /Payment processing error/i.test(msg)) {
      // Per Exp B finding: latency is the only signal that disambiguates rate-limit
      // from settlement-race at this opaque-SDK layer. Classify as rate-limit by
      // default; refined classification happens via the latency-based override
      // pattern in the Gene Capsule's params.
      return { ...base, code: 'gateway-rate-limit', category: 'service', severity: 'medium', apiLayer };
    }
    if (/No Gateway batching option available/i.test(msg)) {
      return { ...base, code: 'method-unsupported', category: 'service', severity: 'high', apiLayer };
    }
  }

  // ── CCTP (cross-chain bridges via TokenMessenger / MessageTransmitter) ──
  // No Group 1 experiments yet; classify minimally so the api_layer is tagged for future
  // capsule learning. Specific failure-code mappings to be added when Exp E lands.
  if (apiLayer === 'cctp') {
    if (/attestation/i.test(msg) && /(missing|timeout|pending)/i.test(msg)) {
      return { ...base, code: 'timeout', category: 'service', severity: 'medium', apiLayer };
    }
    if (/insufficient|exceeds balance/i.test(msg)) {
      return { ...base, code: 'payment-insufficient', category: 'balance', severity: 'high', apiLayer };
    }
  }

  // Generic Circle SDK error shapes — GATED on apiLayer !== null for the
  // same reason as the message fallback above: with circleAdapter now at
  // the front of the chain (so it can claim wallets-api 429s before privy's
  // generic /429/ catches them), we must NOT claim arbitrary errors that
  // happen to mention "503" / "rate limit" / "timeout" but aren't Circle.
  if (apiLayer !== null) {
    if (/unauthorized|invalid api key/i.test(msg)) {
      return { ...base, code: 'rate-limited', category: 'auth', severity: 'medium', apiLayer };
    }
    if (/(rate.?limit|429)/i.test(msg)) {
      return { ...base, code: 'rate-limited', category: 'auth', severity: 'medium', apiLayer };
    }
    if (/timeout|ETIMEDOUT|ETIMEOUT/i.test(msg)) {
      return { ...base, code: 'timeout', category: 'service', severity: 'medium', apiLayer };
    }
    if (/(500|502|503|internal_server_error|service_unavailable|bad_gateway)/i.test(msg)) {
      return { ...base, code: 'server-error', category: 'service', severity: 'high', apiLayer };
    }
  }

  return null;
}
