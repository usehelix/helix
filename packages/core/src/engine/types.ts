// ── Error Codes ──────────────────────────────────────────────────

export type ErrorCode =
  | 'payment-required'
  | 'payment-insufficient'
  | 'payment-expired'
  | 'verification-failed'
  | 'method-unsupported'
  | 'malformed-credential'
  | 'invalid-challenge'
  | 'tx-reverted'
  | 'swap-reverted'
  | 'token-uninitialized'
  | 'tip-403'
  | 'policy-violation'
  | 'cascade-failure'
  | 'offramp-failed'
  | 'rate-limited'
  | 'server-error'
  | 'timeout'
  | 'gas-estimation-failed'
  | 'gas-underpriced'
  | 'gas-too-low'
  | 'gas-spike'
  | 'gas-limit-exceeded'
  | 'nonce-mismatch'
  | 'paymaster-balance-low'
  | 'wallet-locked'
  // Circle-specific (Group 1 nanopayments)
  | 'wallets-api-rate-limit'
  | 'gateway-rate-limit'
  | 'gateway-nonce-used'
  // Circle Web SDK numeric error codes (developers.circle.com/wallets/.../web-sdk)
  | 'circle-param-missing'          // code === 1
  | 'circle-param-invalid'          // code === 2
  | 'circle-forbidden'              // code === 3
  | 'circle-unauthorized'           // code === 4
  | 'circle-retry'                  // code === 9
  | 'circle-customer-suspended'     // code === 10
  | 'circle-pending'                // code === 11
  | 'circle-token-expired'          // code === 155104
  | 'circle-insufficient-funds'     // code === 155201
  | 'circle-exceed-withdraw-limit'  // code === 155203
  | 'circle-pending-tx-queue-full'  // code === 155264
  // CCTP (perceive does not emit yet; callers may emit from CCTP client code)
  | 'cctp-attestation-pending'
  // Experimentally-validated codes (Apr 2026, Arc Testnet)
  | 'decimals-metadata-mismatch'   // Circle Wallets API reports wrong ERC-20 decimals on Arc
  | 'stale_quote'                  // x402 quote TTL exceeded before settlement (underscore is intentional — matches bench audit-log convention)
  | 'unknown';

// ── Failure Categories ──────────────────────────────────────────

export type FailureCategory =
  | 'balance'
  | 'session'
  | 'currency'
  | 'signature'
  | 'batch'
  | 'service'
  | 'dex'
  | 'compliance'
  | 'cascade'
  | 'offramp'
  | 'network'
  | 'policy'
  | 'auth'
  | 'gas'
  | 'nonce'
  | 'infrastructure'   // metadata bugs / chain-side data inconsistencies
  | 'unknown';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type Platform = 'tempo' | 'privy' | 'coinbase' | 'stripe' | 'circle' | 'generic' | 'unknown';

// ── Repair Context ──────────────────────────────────────────────

/**
 * Environmental context at the time of repair.
 * Used by Context-Aware Gene Map to select the best strategy for current conditions.
 */
export interface RepairContext {
  chainId?: number;
  gasPriceGwei?: number;
  hourOfDay?: number;
  agentId?: string;
  [key: string]: unknown;
}

// ── Execution Mode ──────────────────────────────────────────────

export type HelixMode = 'observe' | 'auto' | 'full';

// ── PCEC Types ──────────────────────────────────────────────────

export interface FailureClassification {
  code: ErrorCode;
  category: FailureCategory;
  severity: Severity;
  platform: Platform;
  details: string;
  timestamp: number;
  rootCauseHint?: string;
  llmClassified?: boolean;
  llmReasoning?: string;
  actualBalance?: number;
  requiredAmount?: number;
  chainId?: number;
  /** Sub-chain identifier for multi-chain platforms.
   *  e.g. 'arc-testnet', 'base-mainnet', 'ethereum'. Distinct from chainId
   *  (which is the numeric chain ID); chain is a human-readable label. */
  chain?: string;
  walletAddress?: string;
  /** API sub-layer within a platform (e.g. 'wallets-api' vs 'gateway' for Circle).
   *  Threaded into Gene Map lookup so different strategies can serve different layers. */
  apiLayer?: string | null;
}

/** A single step in a multi-step repair chain */
export interface StrategyStep {
  /** Strategy name to execute */
  strategy: string;
  /** If this step fails, stop the chain (default: true) */
  stopOnFailure?: boolean;
}

export interface RepairCandidate {
  id: string;
  strategy: string;
  /** Multi-step chain. If present, execute steps in order instead of single strategy. */
  steps?: StrategyStep[];
  description: string;
  estimatedCostUsd: number;
  estimatedSpeedMs: number;
  requirements: string[];
  score: number;
  successProbability: number;
  platform: Platform;
  source?: 'adapter' | 'gene' | 'llm' | 'registry';
  reasoning?: string;
}

export interface GeneCapsule {
  id?: number;
  failureCode: ErrorCode;
  category: FailureCategory;
  /** Distinguishes which sub-API of a platform the capsule applies to,
   *  e.g. 'wallets-api' vs 'gateway' for Circle. NULL/undefined = applies
   *  to all layers (legacy capsules). */
  apiLayer?: string | null;
  strategy: string;
  params: Record<string, unknown>;
  successCount: number;
  avgRepairMs: number;
  platforms: Platform[];
  qValue: number;
  qVariance?: number;
  qCount?: number;
  last5Rewards?: number[];
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailedAt?: number;
  createdAt?: string;
  lastUsedAt?: string;
  // OPT-4: ReasoningBank
  reasoning?: string;
  failureAnalysis?: string[];
  successContext?: { chains?: string[]; walletTypes?: string[]; platforms?: string[] };
  failureContext?: { chains?: string[]; walletTypes?: string[]; note?: string };
  /** Multi-dimensional repair scores */
  scores?: Record<string, number>;
  /** Original Q-value before context adjustment (set by context-aware lookup) */
  _originalQValue?: number;
  /** Context similarity score 0.5–1.0 (set by context-aware lookup) */
  _contextSimilarity?: number;
}

export interface RepairResult {
  success: boolean;
  failure: FailureClassification;
  candidates: RepairCandidate[];
  winner: RepairCandidate | null;
  gene: GeneCapsule | null;
  immune: boolean;
  totalMs: number;
  revenueProtected: number;
  mode: HelixMode;
  explanation: string;
  verified: boolean;
  skippedStrategies?: string[];
  costEstimate: number;
  // OPT-10: Failure Attribution
  attribution?: { agentId: string; stepId?: string; workflow?: string; timestamp: number };
  /** Overrides from strategy execution — used by wrap() auto-detect for retry */
  commitOverrides?: Record<string, unknown>;
  /** If strategy chain was used, list of steps executed */
  stepsExecuted?: { strategy: string; success: boolean; ms: number }[];
  /** True if business-level verify() callback returned false */
  verifyFailed?: boolean;
  /** Predicted next failures (from Predictive Failure Graph) */
  predictions?: { code: string; category: string; probability: number; avgDelayMs: number }[];
}

// ── Platform Adapter Interface ──────────────────────────────────

export interface PlatformAdapter {
  name: Platform;
  perceive(error: Error, context?: Record<string, unknown>): FailureClassification | null;
  construct(failure: FailureClassification): RepairCandidate[];
}

// ── Provider Config ─────────────────────────────────────────────

export interface DexConfig {
  routerAddress: `0x${string}`;
  quoterAddress?: `0x${string}`;
  wethAddress: `0x${string}`;
  defaultTokens: { usdc?: `0x${string}`; usdt?: `0x${string}`; dai?: `0x${string}` };
  defaultSlippage: number;
  defaultDeadlineSeconds: number;
}

export interface HelixProviderConfig {
  rpcUrl?: string;
  privateKey?: string;
  privy?: { appId: string; appSecret: string; walletId?: string };
  coinbase?: { apiKeyName: string; apiKeyPrivateKey: string };
  dex?: DexConfig;
}

// ── SSE Event Types ─────────────────────────────────────────────

export type SseEventType =
  | 'perceive'
  | 'construct'
  | 'evaluate'
  | 'commit'
  | 'verify'
  | 'gene'
  | 'immune'
  | 'error'
  | 'stats'
  | 'retry';

export interface SseEvent {
  type: SseEventType;
  agentId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

// ── Config ──────────────────────────────────────────────────────

export interface HelixConfig {
  projectName: string;
  walletAddress: string;
  stablecoins: string[];
  monthlyBudget: number;
  maxRetries: number;
  timeoutMs: number;
  dashboardPort: number;
  verbose: boolean;
  geneMapPath: string;
}

export interface WrapOptions {
  agentId?: string;
  maxRetries?: number;
  verbose?: boolean;
  geneMapPath?: string;
  platforms?: string[];
  config?: Partial<HelixConfig>;
  mode?: HelixMode;
  enabled?: boolean | (() => boolean);
  maxRepairCostUsd?: number;
  maxSlippage?: number;
  approvedTokens?: string[];
  allowCategories?: string[];
  blockStrategies?: string[];
  provider?: HelixProviderConfig;
  onRepair?: (result: RepairResult) => void;
  onFailure?: (result: RepairResult) => void;
  onHelixError?: (error: Error) => void;
  onSystematic?: (warning: string, failure: FailureClassification) => void;
  /** Apply repair overrides to function args for retry. */
  parameterModifier?: (args: unknown[], overrides: Record<string, unknown>, strategy: string) => unknown[];
  context?: Record<string, unknown>;
  /** LLM fallback for classifying unknown errors. Disabled by default. */
  llm?: { provider?: 'anthropic' | 'openai'; apiKey?: string; fallbackApiKey?: string; model?: string; timeoutMs?: number; enabled?: boolean };
  /** Telemetry: anonymously report discoveries to improve seed genes. Default: disabled. */
  telemetry?: { enabled?: boolean; endpoint?: string; onTelemetry?: (event: unknown) => boolean };
  /** Custom logger (pino, winston, etc). Default: console with colors. */
  logger?: { debug(m: string, d?: Record<string, unknown>): void; info(m: string, d?: Record<string, unknown>): void; warn(m: string, d?: Record<string, unknown>): void; error(m: string, d?: Record<string, unknown>): void };
  /** Log level. Default: 'warn'. Set 'info' for verbose, 'debug' for everything. */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** Log format. 'pretty' (colored) or 'json' (structured). Default: 'pretty'. */
  logFormat?: 'pretty' | 'json';
  /**
   * Business-level verification after successful repair + retry.
   *
   * Called after the retried function succeeds. If verify returns false,
   * the repair is treated as a failure (Gene q_value decreases).
   *
   * @param result - The return value of the retried function
   * @param originalArgs - The original arguments passed to wrap(fn)
   * @returns true if the result is valid, false to treat as failure
   */
  verify?: (result: unknown, originalArgs: unknown[]) => Promise<boolean> | boolean;
  /** OpenTelemetry configuration. Provide your own tracer/meter for distributed tracing and metrics. */
  otel?: { tracer?: any; meter?: any; serviceName?: string };
  /**
   * Gene Registry Cloud configuration for shared learning across instances.
   * `url` and `writeKey` are the only fields used by the current per-commit
   * sync model (see engine/registry-bridge.ts). Env vars take precedence:
   *   GENE_REGISTRY_URL > options.registry.url
   *   GENE_REGISTRY_WRITE_KEY > options.registry.writeKey > options.registry.apiKey
   */
  registry?: {
    /** Gene Registry Cloud base URL, e.g. https://helix-telemetry.haimobai-adrian.workers.dev */
    url?: string;
    /** Shared secret for POST /v1/capsules. Sent as x-registry-key header. */
    writeKey?: string;
    /** @deprecated since 2.7.3 — fallback for legacy callers. Use `writeKey`. */
    apiKey?: string;
    /** Agent identifier sent with capsule pushes for provenance. */
    agentId?: string;
    /** @deprecated since 2.7.3 — legacy GeneRegistryClient batch knob, ignored. */
    minQualityForPush?: number;
    /** @deprecated since 2.7.3 — legacy GeneRegistryClient batch knob, ignored. */
    minQualityForPull?: number;
    /** @deprecated since 2.7.3 — legacy GeneRegistryClient batch knob, ignored. */
    syncIntervalMs?: number;
    /** @deprecated since 2.7.3 — legacy GeneRegistryClient batch knob, ignored. */
    pushBatchSize?: number;
    /** @deprecated since 2.7.3 — legacy GeneRegistryClient batch knob, ignored. */
    pullBatchSize?: number;
  };
  /** Callback to refresh session/auth token when renew_session strategy fires. */
  sessionRefresher?: () => Promise<Record<string, unknown> | string>;
  /** Config for split_transaction strategy. */
  splitConfig?: { parts?: number; delayMs?: number; minAmount?: number };
}

// ── Trace Entry (PCEC Construct trace-aware fallback) ──────────
// Materialized row from repair_audit (LEFT JOIN failed_repairs) used to
// build trace-aware LLM Construct prompts. See gene-map.ts:getRecentTraces
// and llm.ts:buildConstructPrompt for the producer/consumer ends.

export interface TraceEntry {
  /** SAMECODE = same failure_code as current; CATEGORY = same category, different code (broader pattern). */
  tag: 'SAMECODE' | 'CATEGORY';
  /** Wall-clock ms (Date.now()) — used for relative-time formatting. */
  timestamp: number;
  failureCode: string;
  failureCategory: string;
  strategy: string;
  success: boolean;
  immune: boolean;
  durationMs: number;
  qBefore?: number | null;
  qAfter?: number | null;
  errorMessage?: string;
  /** From failed_repairs LEFT JOIN — only present when ✗ and recorded within 5s of audit. */
  repairError?: string;
}

// ── Revenue estimates per category ──────────────────────────────

export const REVENUE_AT_RISK: Record<string, number> = {
  balance: 150, session: 50, currency: 200, signature: 100,
  batch: 500, service: 300, dex: 175, compliance: 250,
  cascade: 1000, offramp: 400, network: 100, policy: 200,
  auth: 50, unknown: 50,
};

// ── Default Config ──────────────────────────────────────────────

export const DEFAULT_CONFIG: HelixConfig = {
  projectName: 'helix-agent',
  walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
  stablecoins: ['USDC', 'USDT', 'DAI'],
  monthlyBudget: 10000,
  maxRetries: 3,
  timeoutMs: 30000,
  dashboardPort: 7842,
  verbose: true,
  geneMapPath: './helix-genes.db',
};
