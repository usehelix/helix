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

function detectApiLayer(error: Error, context?: Record<string, unknown>): ApiLayer {
  const url = String(context?.url ?? context?.requestUrl ?? '') + ' ' + error.message;
  if (/api\.circle\.com\/v1\/w3s/i.test(url)) return 'wallets-api';
  if (/gateway-api(-testnet)?\.circle\.com/i.test(url)) return 'gateway';
  if (/x402-batching/i.test(url)) return 'gateway';
  if (/TokenMessenger|MessageTransmitter|\bcctp\b/i.test(url)) return 'cctp';
  return null;
}

export function circlePerceive(error: Error, context?: Record<string, unknown>): FailureClassification | null {
  const msg = error.message;
  const platform: Platform = 'circle';
  const apiLayer = detectApiLayer(error, context);

  const base = { severity: 'medium' as const, platform, details: msg, timestamp: Date.now() };

  // ── Wallets API (api.circle.com/v1/w3s) ──
  // Exp B: undocumented ~5 concurrent tx cap, returns {"code":5,"message":"API rate limit error"}
  if (apiLayer === 'wallets-api') {
    const errCode = (error as any)?.response?.data?.code ?? (context as any)?.errorCode;
    if (errCode === 5 || /code:\s*5|API rate limit/i.test(msg)) {
      return { ...base, code: 'wallets-api-rate-limit', category: 'auth', severity: 'medium', apiLayer };
    }
    if (/insufficient|exceeds balance/i.test(msg)) {
      return { ...base, code: 'payment-insufficient', category: 'balance', severity: 'high', apiLayer };
    }
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

  // Generic Circle SDK error shapes that can appear on any api_layer
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

  return null;
}
