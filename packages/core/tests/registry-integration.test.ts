import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  pushCapsuleToRegistry,
  queryRegistry,
  registryCapsuleToCandidate,
  resolveRegistryConfig,
  type RegistryRuntimeConfig,
  type RegistryCapsule,
} from '../src/engine/registry-bridge.js';
import type { GeneCapsule, FailureClassification } from '../src/engine/types.js';

const CFG: RegistryRuntimeConfig = {
  url: 'https://registry.example.test',
  writeKey: 'test-write-key',
  agentId: 'test-agent-001',
};

const SAMPLE_CAPSULE: GeneCapsule = {
  failureCode: 'rate-limited',
  category: 'auth',
  strategy: 'switch_endpoint',
  params: {},
  successCount: 7,
  qCount: 9,
  avgRepairMs: 850,
  platforms: ['generic'],
  qValue: 0.74,
  consecutiveFailures: 0,
};

const SAMPLE_FAILURE: FailureClassification = {
  code: 'rate-limited',
  category: 'auth',
  severity: 'medium',
  platform: 'generic',
  details: '429 Too Many Requests',
  timestamp: 1700000000000,
};

describe('registry-bridge — pushCapsuleToRegistry', () => {
  it('POSTs to /v1/capsules with x-registry-key header and correct body', async () => {
    const fetchSpy = vi.fn(async (_url: any, _init: any) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const ok = await pushCapsuleToRegistry(CFG, SAMPLE_CAPSULE, { fetchImpl: fetchSpy as any });
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://registry.example.test/v1/capsules');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['x-registry-key']).toBe('test-write-key');
    const body = JSON.parse(init.body);
    expect(body.failure_code).toBe('rate-limited');
    expect(body.strategy).toBe('switch_endpoint');
    expect(body.q_value).toBe(0.74);
    expect(body.success_count).toBe(7);
    expect(body.total_count).toBe(9); // qCount preferred over successCount
    expect(body.agent_id).toBe('test-agent-001');
    expect(body.capsule_schema_version).toBe(1);
  });

  it('returns false (no throw) when no writeKey configured', async () => {
    const fetchSpy = vi.fn();
    const cfgNoKey: RegistryRuntimeConfig = { url: CFG.url, agentId: CFG.agentId };
    const ok = await pushCapsuleToRegistry(cfgNoKey, SAMPLE_CAPSULE, { fetchImpl: fetchSpy as any });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('registry-bridge — queryRegistry', () => {
  it('returns hit + capsule when worker responds {found:true,capsule:...}', async () => {
    const fakeCapsule: RegistryCapsule = {
      failure_code: 'rate-limited',
      category: 'auth',
      platform: 'generic',
      strategy: 'switch_endpoint',
      q_value: 0.81,
      success_count: 12,
      total_count: 14,
      avg_repair_ms: 920,
      capsule_schema_version: 1,
      agent_id: 'helix-core-mac-haimo',
    };
    const fetchSpy = vi.fn(async (url: any) => {
      // Verify query string composition
      expect(String(url)).toContain('code=rate-limited');
      expect(String(url)).toContain('category=auth');
      expect(String(url)).toContain('platform=generic');
      return new Response(JSON.stringify({ found: true, capsule: fakeCapsule }), { status: 200 });
    });
    const result = await queryRegistry(CFG, 'rate-limited', 'auth', 'generic', { fetchImpl: fetchSpy as any });
    expect(result.outcome).toBe('hit');
    expect(result.capsule).toEqual(fakeCapsule);
  });

  it('returns miss when worker responds {found:false}', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ found: false, capsule: null }), { status: 200 }),
    );
    const result = await queryRegistry(CFG, 'totally-novel-code', 'unknown', 'generic', { fetchImpl: fetchSpy as any });
    expect(result.outcome).toBe('miss');
    expect(result.capsule).toBeNull();
  });

  it('returns timeout outcome when fetch raises TimeoutError', async () => {
    const fetchSpy = vi.fn(async () => {
      const err: any = new DOMException('aborted', 'TimeoutError');
      throw err;
    });
    const result = await queryRegistry(CFG, 'rate-limited', 'auth', 'generic', { fetchImpl: fetchSpy as any, timeoutMs: 50 });
    expect(result.outcome).toBe('timeout');
    expect(result.capsule).toBeNull();
  });

  it('returns error outcome on non-2xx', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response('boom', { status: 500 }),
    );
    const result = await queryRegistry(CFG, 'rate-limited', 'auth', 'generic', { fetchImpl: fetchSpy as any });
    expect(result.outcome).toBe('error');
    expect(result.capsule).toBeNull();
  });
});

describe('registry-bridge — registryCapsuleToCandidate', () => {
  it('builds a RepairCandidate with source="registry" and reasoning name-tagged to capsule.agent_id', () => {
    const capsule: RegistryCapsule = {
      failure_code: 'rate-limited',
      category: 'auth',
      platform: 'generic',
      strategy: 'switch_endpoint',
      q_value: 0.81,
      success_count: 12,
      total_count: 14,
      avg_repair_ms: 920,
      agent_id: 'helix-core-mac-haimo',
    };
    const candidate = registryCapsuleToCandidate(capsule, SAMPLE_FAILURE);
    expect(candidate.source).toBe('registry');
    expect(candidate.strategy).toBe('switch_endpoint');
    expect(candidate.successProbability).toBe(0.81);
    expect(candidate.reasoning).toContain('helix-core-mac-haimo');
    expect(candidate.description).toContain('q=0.81');
    expect(candidate.description).toContain('n=12');
    expect(candidate.platform).toBe('generic');
  });

  it('falls back reasoning name to "unknown" when capsule has no agent_id', () => {
    const capsule: RegistryCapsule = {
      failure_code: 'foo', category: 'unknown', platform: 'generic',
      strategy: 'retry', q_value: 0.5, success_count: 0, total_count: 0, avg_repair_ms: null,
    };
    const candidate = registryCapsuleToCandidate(capsule, SAMPLE_FAILURE);
    expect(candidate.reasoning).toContain('unknown');
  });
});

describe('registry-bridge — resolveRegistryConfig env precedence', () => {
  // Keep envs we may mutate snapshotted across tests
  let originalUrl: string | undefined;
  let originalKey: string | undefined;
  let originalAgent: string | undefined;

  beforeEach(() => {
    originalUrl = process.env.GENE_REGISTRY_URL;
    originalKey = process.env.GENE_REGISTRY_WRITE_KEY;
    originalAgent = process.env.GENE_REGISTRY_AGENT_ID;
    delete process.env.GENE_REGISTRY_URL;
    delete process.env.GENE_REGISTRY_WRITE_KEY;
    delete process.env.GENE_REGISTRY_AGENT_ID;
  });
  afterEach(() => {
    if (originalUrl !== undefined) process.env.GENE_REGISTRY_URL = originalUrl; else delete process.env.GENE_REGISTRY_URL;
    if (originalKey !== undefined) process.env.GENE_REGISTRY_WRITE_KEY = originalKey; else delete process.env.GENE_REGISTRY_WRITE_KEY;
    if (originalAgent !== undefined) process.env.GENE_REGISTRY_AGENT_ID = originalAgent; else delete process.env.GENE_REGISTRY_AGENT_ID;
  });

  it('returns undefined when neither env nor options has a URL', () => {
    expect(resolveRegistryConfig(undefined, 'fallback-id')).toBeUndefined();
    expect(resolveRegistryConfig({}, 'fallback-id')).toBeUndefined();
  });

  it('env URL wins over options URL', () => {
    process.env.GENE_REGISTRY_URL = 'https://env.example.test';
    const cfg = resolveRegistryConfig({ url: 'https://opt.example.test' }, 'fallback-id');
    expect(cfg?.url).toBe('https://env.example.test');
  });

  it('env writeKey wins over options.writeKey, which wins over options.apiKey (legacy)', () => {
    const cfgEnv = resolveRegistryConfig({ url: 'https://x', writeKey: 'opt-w', apiKey: 'opt-a' }, 'id');
    expect(cfgEnv?.writeKey).toBe('opt-w');
    process.env.GENE_REGISTRY_WRITE_KEY = 'env-w';
    const cfgEnv2 = resolveRegistryConfig({ url: 'https://x', writeKey: 'opt-w', apiKey: 'opt-a' }, 'id');
    expect(cfgEnv2?.writeKey).toBe('env-w');
    delete process.env.GENE_REGISTRY_WRITE_KEY;
    const cfgLegacy = resolveRegistryConfig({ url: 'https://x', apiKey: 'opt-a' }, 'id');
    expect(cfgLegacy?.writeKey).toBe('opt-a');
  });

  it('strips trailing slash from URL', () => {
    const cfg = resolveRegistryConfig({ url: 'https://example.test/' }, 'id');
    expect(cfg?.url).toBe('https://example.test');
  });

  it('agentId resolution: env > options > fallback', () => {
    expect(resolveRegistryConfig({ url: 'https://x' }, 'fallback')?.agentId).toBe('fallback');
    expect(resolveRegistryConfig({ url: 'https://x', agentId: 'opt' }, 'fallback')?.agentId).toBe('opt');
    process.env.GENE_REGISTRY_AGENT_ID = 'env-id';
    expect(resolveRegistryConfig({ url: 'https://x', agentId: 'opt' }, 'fallback')?.agentId).toBe('env-id');
  });
});
