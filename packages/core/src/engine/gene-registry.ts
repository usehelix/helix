/**
 * @deprecated since 2.7.3 — superseded by engine/registry-bridge.ts.
 *
 * This batch push/pull client targets a legacy HTTP API
 * (POST /v1/genes/push, GET /v1/genes/pull) that was never deployed
 * on the production Gene Registry Cloud worker. The current per-commit
 * sync model (POST /v1/capsules, GET /v1/capsules) lives in
 * registry-bridge.ts and is wired directly from PCEC.
 *
 * Kept here for type/import backward compatibility. PCEC no longer
 * instantiates this class. Will be removed in a future major.
 */

import type { GeneMap } from './gene-map.js';
import type { Platform } from './types.js';

export interface GeneRegistryConfig {
  /** Registry URL. Required. */
  url?: string;
  /** API key for authentication */
  apiKey?: string;
  /** Agent ID for attribution */
  agentId?: string;
  /** Only push Genes with q_value above this. Default: 0.7 */
  minQualityForPush?: number;
  /** Only pull Genes with q_value above this. Default: 0.5 */
  minQualityForPull?: number;
  /** Auto-sync interval in ms. 0 = manual only. Default: 0 */
  syncIntervalMs?: number;
  /** Max Genes to push per sync. Default: 50 */
  pushBatchSize?: number;
  /** Max Genes to pull per sync. Default: 100 */
  pullBatchSize?: number;
}

/** A Gene as represented in the registry (minimal, privacy-preserving) */
export interface RegistryGene {
  id?: string;
  failureCode: string;
  failureCategory: string;
  strategy: string;
  qValue: number;
  qVariance?: number;
  successCount: number;
  platforms: string[];
  reasoning?: string;
  contributorAgentId?: string;
  createdAt: number;
  lastVerifiedAt?: number;
  verifiedByCount?: number;
}

/** @deprecated since 2.7.3 — see file header. */
export class GeneRegistryClient {
  private url: string;
  private apiKey: string;
  private agentId: string;
  private minQPush: number;
  private minQPull: number;
  private pushBatch: number;
  private pullBatch: number;
  private syncIntervalMs: number;
  private syncTimer?: ReturnType<typeof setInterval>;

  constructor(config: GeneRegistryConfig) {
    if (!config.url) throw new Error('Gene Registry URL is required');
    this.url = config.url.replace(/\/$/, '');
    this.apiKey = config.apiKey ?? '';
    this.agentId = config.agentId ?? 'anonymous';
    this.minQPush = config.minQualityForPush ?? 0.7;
    this.minQPull = config.minQualityForPull ?? 0.5;
    this.pushBatch = config.pushBatchSize ?? 50;
    this.pullBatch = config.pullBatchSize ?? 100;
    this.syncIntervalMs = config.syncIntervalMs ?? 0;
  }

  startAutoSync(geneMap: GeneMap): void {
    if (this.syncIntervalMs <= 0) return;
    this.syncTimer = setInterval(async () => {
      try { await this.push(geneMap); await this.pull(geneMap); } catch { /* silent */ }
    }, this.syncIntervalMs);
  }

  stopAutoSync(): void {
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = undefined; }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', 'X-Agent-Id': this.agentId };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  async push(geneMap: GeneMap): Promise<{ pushed: number; skipped: number }> {
    const genes = geneMap.list();
    const qualified = genes
      .filter(g => g.qValue >= this.minQPush && g.successCount >= 3)
      .slice(0, this.pushBatch);

    if (qualified.length === 0) return { pushed: 0, skipped: genes.length };

    const payload: RegistryGene[] = qualified.map(g => ({
      failureCode: g.failureCode,
      failureCategory: g.category,
      strategy: g.strategy,
      qValue: g.qValue,
      qVariance: g.qVariance,
      successCount: g.successCount,
      platforms: g.platforms,
      reasoning: g.reasoning,
      contributorAgentId: this.agentId,
      createdAt: Date.now(),
    }));

    const res = await fetch(`${this.url}/v1/genes/push`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ genes: payload }),
    });

    if (!res.ok) throw new Error(`Registry push failed: ${res.status} ${res.statusText}`);
    const result = await res.json() as { accepted: number; rejected: number };
    return { pushed: result.accepted, skipped: genes.length - qualified.length + result.rejected };
  }

  async pull(geneMap: GeneMap): Promise<{ pulled: number; skipped: number }> {
    const res = await fetch(`${this.url}/v1/genes/pull?minQ=${this.minQPull}&limit=${this.pullBatch}`, {
      headers: this.headers(),
    });

    if (!res.ok) throw new Error(`Registry pull failed: ${res.status} ${res.statusText}`);
    const data = await res.json() as { genes: RegistryGene[] };
    let pulled = 0;
    let skipped = 0;

    for (const rGene of data.genes) {
      const local = geneMap.list().find(
        g => g.failureCode === rGene.failureCode && g.category === rGene.failureCategory,
      );
      if (local) { skipped++; continue; }

      geneMap.store({
        failureCode: rGene.failureCode as any,
        category: rGene.failureCategory as any,
        strategy: rGene.strategy,
        params: {},
        successCount: 0,
        avgRepairMs: 0,
        platforms: rGene.platforms as Platform[],
        qValue: rGene.qValue * 0.8, // 20% discount — not locally verified
        consecutiveFailures: 0,
      });
      pulled++;
    }

    return { pulled, skipped };
  }

  async health(): Promise<{ status: string; totalGenes: number; totalAgents: number }> {
    const res = await fetch(`${this.url}/v1/health`);
    if (!res.ok) throw new Error(`Registry health check failed: ${res.status}`);
    return res.json() as Promise<{ status: string; totalGenes: number; totalAgents: number }>;
  }
}
