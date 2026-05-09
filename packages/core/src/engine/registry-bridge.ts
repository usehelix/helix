/**
 * Gene Registry Cloud bridge — per-commit push + on-demand query.
 *
 * Replaces the legacy batch-oriented `GeneRegistryClient` (gene-registry.ts).
 * Targets the production worker API at /v1/capsules:
 *   POST /v1/capsules   — push one capsule (requires x-registry-key header)
 *   GET  /v1/capsules   — public read, ?code=&category=&platform=
 *
 * Design rules:
 *   - PUSH is fire-and-forget — never blocks the PCEC commit hot path.
 *     Caller wraps in `.catch(() => {})`. Failures are counted but silent.
 *   - QUERY is blocking with a tight 200ms hard timeout via
 *     AbortSignal.timeout(200). On timeout/error, returns null and the
 *     caller falls back to adapter+LLM as if Registry weren't configured.
 *   - All helpers accept an injectable `fetchImpl` so tests can mock without
 *     touching globalThis.fetch.
 */

import type { GeneCapsule, RepairCandidate, FailureClassification, ErrorCode, FailureCategory, Platform } from './types.js';

export interface RegistryRuntimeConfig {
  /** Resolved registry URL (from env GENE_REGISTRY_URL or options.registry.url). */
  url: string;
  /** Resolved write key. Required for push; queries work without it (public reads). */
  writeKey?: string;
  /** Agent identifier sent on push for provenance. */
  agentId: string;
}

export type FetchImpl = typeof fetch;

/** Wire shape returned by GET /v1/capsules. Mirrors worker response. */
export interface RegistryCapsule {
  failure_code: string;
  category: string;
  platform: string;
  strategy: string;
  q_value: number;
  success_count: number;
  total_count: number;
  avg_repair_ms: number | null;
  capsule_schema_version?: number;
  agent_id?: string | null;
  sdk_version?: string | null;
  chain_id?: number | null;
}

/**
 * Push a capsule to the Registry. Returns true on 2xx, false on any
 * other outcome (timeout, network, 4xx, 5xx). Never throws.
 *
 * Capsule schema version pinned to 1 — bump when adding semantic fields
 * the Registry should learn to read.
 */
export async function pushCapsuleToRegistry(
  cfg: RegistryRuntimeConfig,
  capsule: GeneCapsule,
  opts: { platform?: string; chainId?: number; sdkVersion?: string; fetchImpl?: FetchImpl } = {},
): Promise<boolean> {
  if (!cfg.writeKey) return false;
  const platform = opts.platform ?? capsule.platforms?.[0] ?? 'generic';
  const fetchImpl = opts.fetchImpl ?? fetch;
  // qCount is cumulative attempts (success + fail); fall back to successCount
  // for fresh capsules that haven't been through updateQValue yet.
  const total_count = capsule.qCount ?? capsule.successCount;
  const body = JSON.stringify({
    failure_code: capsule.failureCode,
    category: capsule.category,
    platform,
    strategy: capsule.strategy,
    q_value: capsule.qValue,
    success_count: capsule.successCount,
    total_count,
    avg_repair_ms: capsule.avgRepairMs,
    capsule_schema_version: 1,
    agent_id: cfg.agentId,
    sdk_version: opts.sdkVersion ?? 'helix-core',
    chain_id: opts.chainId ?? null,
  });
  try {
    const res = await fetchImpl(`${cfg.url}/v1/capsules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-registry-key': cfg.writeKey },
      body,
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export type QueryOutcome = 'hit' | 'miss' | 'timeout' | 'error';

export interface QueryResult {
  outcome: QueryOutcome;
  capsule: RegistryCapsule | null;
}

/**
 * Look up the best capsule for a (code, category, platform) on the Registry.
 * Hard 200ms timeout via AbortSignal.timeout. On timeout/network failure,
 * outcome='timeout'/'error' and capsule=null.
 *
 * Outcome distinguished so PCEC can count timeouts separately from genuine
 * misses (signal vs noise in dashboards).
 */
export async function queryRegistry(
  cfg: RegistryRuntimeConfig,
  code: string,
  category?: string,
  platform?: string,
  opts: { timeoutMs?: number; fetchImpl?: FetchImpl } = {},
): Promise<QueryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 200;
  const params = new URLSearchParams({ code });
  if (category) params.set('category', category);
  if (platform) params.set('platform', platform);
  try {
    const res = await fetchImpl(`${cfg.url}/v1/capsules?${params.toString()}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { outcome: 'error', capsule: null };
    const data = await res.json() as { found: boolean; capsule: RegistryCapsule | null };
    if (!data.found || !data.capsule) return { outcome: 'miss', capsule: null };
    return { outcome: 'hit', capsule: data.capsule };
  } catch (err: any) {
    // AbortSignal.timeout → DOMException with name 'TimeoutError'
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { outcome: 'timeout', capsule: null };
    }
    return { outcome: 'error', capsule: null };
  }
}

/**
 * Convert a Registry capsule into a synthetic RepairCandidate that flows
 * through the existing PCEC Construct → Evaluate → Commit pipeline.
 * Marked `source: 'registry'` so downstream code (telemetry, audit) can
 * distinguish Registry-sourced repairs from adapter / LLM / local-gene ones.
 */
export function registryCapsuleToCandidate(
  capsule: RegistryCapsule,
  failure: FailureClassification,
): RepairCandidate {
  return {
    id: `registry_${capsule.failure_code}_${capsule.platform}`,
    strategy: capsule.strategy,
    description: `Registry hit: ${capsule.strategy} (q=${Number(capsule.q_value).toFixed(2)}, n=${capsule.success_count})`,
    estimatedCostUsd: 0,
    estimatedSpeedMs: capsule.avg_repair_ms ?? 1000,
    requirements: [],
    score: 0,
    successProbability: capsule.q_value,
    platform: failure.platform as Platform,
    source: 'registry',
    reasoning: `Registry hit from ${capsule.agent_id ?? 'unknown'}`,
  };
}

/**
 * Resolve the runtime registry config from PCEC options + environment.
 * Returns undefined when no URL is configured (Registry features disabled).
 *
 *   GENE_REGISTRY_URL        > options.url
 *   GENE_REGISTRY_WRITE_KEY  > options.writeKey > options.apiKey  (legacy)
 *   GENE_REGISTRY_AGENT_ID   > options.agentId  > fallback
 */
export function resolveRegistryConfig(
  options: { url?: string; writeKey?: string; apiKey?: string; agentId?: string } | undefined,
  fallbackAgentId: string,
): RegistryRuntimeConfig | undefined {
  const url = process.env.GENE_REGISTRY_URL ?? options?.url;
  if (!url) return undefined;
  const writeKey = process.env.GENE_REGISTRY_WRITE_KEY ?? options?.writeKey ?? options?.apiKey;
  const agentId = process.env.GENE_REGISTRY_AGENT_ID ?? options?.agentId ?? fallbackAgentId;
  return { url: url.replace(/\/$/, ''), writeKey, agentId };
}

// Re-exported types for tests / scripts that don't want to touch types.ts.
export type { ErrorCode, FailureCategory, Platform };
