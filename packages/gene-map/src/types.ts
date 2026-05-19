export interface GeneCapsule {
  id?: number;
  failureCode: string;
  category: string;
  /** Distinguishes which sub-API of a platform the capsule applies to,
   *  e.g. 'wallets-api' vs 'gateway' for Circle. NULL/undefined = applies
   *  to all layers (legacy capsules). */
  apiLayer?: string | null;
  strategy: string;
  params: Record<string, unknown>;
  successCount: number;
  avgRepairMs: number;
  platforms: string[];
  qValue: number;
  qVariance?: number;
  qCount?: number;
  last5Rewards?: number[];
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailedAt?: number;
  createdAt?: string;
  lastUsedAt?: string;
  reasoning?: string;
  failureAnalysis?: string[];
  successContext?: Record<string, unknown>;
  failureContext?: Record<string, unknown>;
  scores?: Record<string, number>;
}

export interface GeneMapOptions {
  dbPath?: string;
  /** Gene Registry Cloud base URL, e.g. https://helix-telemetry.haimobai-adrian.workers.dev. Falls back to process.env.GENE_REGISTRY_URL. */
  registryUrl?: string;
  /** Optional agent identifier sent with capsule pushes for provenance. Falls back to process.env.GENE_REGISTRY_AGENT_ID. */
  agentId?: string;
  /** Shared secret required by registry POST /v1/capsules. Falls back to process.env.GENE_REGISTRY_WRITE_KEY. Without it, syncToRegistry is a no-op. */
  writeKey?: string;
}
