import { bus } from './bus.js';
import { refine, filterCandidates, createRefinementContext, recordAttempt } from './self-refine.js';
import { PromptOptimizer } from './prompt-optimizer.js';
import { GeneMap } from './gene-map.js';
import { evaluate } from './evaluate.js';
import { HelixProvider } from './provider.js';
import type { CommitResult } from './provider.js';
import { resolveRegistryConfig, pushCapsuleToRegistry, queryRegistry, registryCapsuleToCandidate } from './registry-bridge.js';
import type {
  FailureClassification,
  GeneCapsule,
  HelixMode,
  PlatformAdapter,
  RepairCandidate,
  RepairContext,
  RepairResult,
  WrapOptions,
  ErrorCode,
  FailureCategory,
} from './types.js';
import { REVENUE_AT_RISK } from './types.js';
import { getRootCause } from './root-causes.js';
import { detectStrategyChain, isChainStrategy, parseChainSteps } from './chain.js';
import { executeChain } from './chain-executor.js';
import { HelixOtel, NOOP_OTEL } from './otel.js';
import { GeneRegistryClient } from './gene-registry.js';
import { matchErrorSignature } from './error-embedding.js';
import { ABTestManager } from './ab-test.js';
import { maybeDistillFromFailures } from './failure-distiller.js';
import { computeRepairScore } from './repair-score.js';
import type { ABTest } from './ab-test.js';
import { CausalGraph } from './causal-graph.js';
import { NegativeKnowledge } from './negative-knowledge.js';
import { MetaLearner } from './meta-learner.js';
import { SafetyVerifier } from './safety-verifier.js';
import { AdaptiveWeights } from './adaptive-weights.js';
import { getConditionMultiplier, updateGeneConditions } from './conditional-genes.js';

// Category C strategies that move funds — require 'full' mode
const FUND_MOVEMENT_STRATEGIES = [
  'swap_currency', 'split_transaction', 'topup_from_reserve',
  'cancel_pending_txs', 'switch_stablecoin', 'split_swap',
  'swap_direct', 'swap_multihop', 'bridge_tokens', 'top_up_sponsor',
  'self_pay_gas', 'create_target_wallet', 'reroute_via_alt',
  'refund_waterfall', 'switch_offramp',
];

function makeResult(partial: Partial<RepairResult> & { failure: FailureClassification }): RepairResult {
  return {
    success: false,
    candidates: [],
    winner: null,
    gene: null,
    immune: false,
    totalMs: 0,
    revenueProtected: 0,
    mode: 'observe',
    explanation: '',
    verified: false,
    costEstimate: 0,
    ...partial,
  };
}

export class PcecEngine {
  private adapters: PlatformAdapter[] = [];
  private geneMap: GeneMap;
  private agentId: string;
  private provider: HelixProvider;
  private options: WrapOptions;
  public stats = { repairs: 0, savedRevenue: 0, immuneHits: 0 };
  private readonly MAX_CYCLES = 50;
  private cycleCount = 0;
  /** D6: Systematic failure tracker */
  private failureTracker: Map<string, { count: number; firstSeen: number; lastSeen: number }> = new Map();
  /** OPT-5: Recent failures for co-occurrence detection */
  private recentFailures: { code: string; category: string; timestamp: number }[] = [];
  /** Predictive Failure Graph: last failure for transition tracking */
  private lastFailure: { code: string; category: string; timestamp: number } | null = null;
  private otel: HelixOtel;
  /** @deprecated since 2.7.3 — kept for backward compat, no longer instantiated. See registry-bridge.ts. */
  private registry?: GeneRegistryClient;
  /** Resolved Gene Registry Cloud config (env > options). Undefined ⇒ Registry features disabled. */
  private registryCfg?: import('./registry-bridge.js').RegistryRuntimeConfig;
  /** Telemetry counters for Registry interactions — exposed via getMetrics(). */
  private registrySyncCount = 0;
  private registrySyncFailures = 0;
  private registryQueryCount = 0;
  private registryQueryHits = 0;
  private registryQueryTimeouts = 0;
  /** LLM Construct fallback fire count — for stress-test reporting. */
  private llmConstructCalls = 0;
  private abTests: ABTestManager = new ABTestManager();
  private causalGraph: CausalGraph;
  private negativeKnowledge: NegativeKnowledge;
  private metaLearner: MetaLearner;
  private safetyVerifier: SafetyVerifier;
  private adaptiveWeights: AdaptiveWeights;
  private promptOptimizer: PromptOptimizer;

  constructor(geneMap: GeneMap, agentId: string = 'default', options?: WrapOptions) {
    this.geneMap = geneMap;
    this.agentId = agentId;
    this.options = options ?? {};
    this.provider = new HelixProvider(options?.provider);
    this.otel = options?.otel ? new HelixOtel(options.otel) : NOOP_OTEL;
    this.causalGraph = new CausalGraph(geneMap.database);
    this.negativeKnowledge = new NegativeKnowledge(geneMap.database);
    this.metaLearner = new MetaLearner(geneMap.database);
    this.safetyVerifier = new SafetyVerifier();
    this.adaptiveWeights = new AdaptiveWeights(geneMap.database);
    this.promptOptimizer = new PromptOptimizer(geneMap.database);
    // Gene Registry Cloud — resolved from env (preferred) + options. The
    // legacy GeneRegistryClient batch path is no longer instantiated; the
    // bridge in engine/registry-bridge.ts handles per-commit push and
    // per-miss query directly. See also: WrapOptions.registry JSDoc.
    this.registryCfg = resolveRegistryConfig(options?.registry, this.agentId);
  }

  /**
   * @deprecated since 2.7.3 — registry sync is now per-commit fire-and-forget,
   * see registry-bridge.ts. This method is now a no-op for back compat.
   */
  async syncRegistry(): Promise<{ pushed: number; pulled: number }> {
    return { pushed: 0, pulled: 0 };
  }

  /**
   * Telemetry counters for Gene Registry Cloud interactions on this engine.
   * Used by the dogfood stress-test script and observability dashboards.
   * Counts are monotonic; reset only by re-instantiating the engine.
   */
  getMetrics(): {
    immuneHits: number;
    repairs: number;
    llmConstructCalls: number;
    registrySyncCount: number;
    registrySyncFailures: number;
    registryQueryCount: number;
    registryQueryHits: number;
    registryQueryTimeouts: number;
  } {
    return {
      immuneHits: this.stats.immuneHits,
      repairs: this.stats.repairs,
      llmConstructCalls: this.llmConstructCalls,
      registrySyncCount: this.registrySyncCount,
      registrySyncFailures: this.registrySyncFailures,
      registryQueryCount: this.registryQueryCount,
      registryQueryHits: this.registryQueryHits,
      registryQueryTimeouts: this.registryQueryTimeouts,
    };
  }

  private checkSystematic(failure: FailureClassification): string | null {
    const key = `${this.agentId}:${failure.code}:${failure.category}`;
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const tracker = this.failureTracker.get(key);
    if (!tracker || now - tracker.lastSeen > oneHour) {
      this.failureTracker.set(key, { count: 1, firstSeen: now, lastSeen: now });
      return null;
    }
    tracker.count++;
    tracker.lastSeen = now;
    if (tracker.count >= 5) {
      return `SYSTEMATIC: ${failure.code}/${failure.category} triggered ${tracker.count}x in ${Math.round((now - tracker.firstSeen) / 60000)}min for agent '${this.agentId}'. Likely a code bug, not transient.`;
    }
    return null;
  }

  registerAdapter(adapter: PlatformAdapter): void {
    this.adapters.push(adapter);
  }

  /** D16: Negative pattern guard — prevent false positives from success messages */
  private shouldSkipPerceive(error: Error): boolean {
    const msg = error.message.toLowerCase();
    const successIndicators = ['success', 'completed', 'confirmed', 'approved', 'settled', 'transferred successfully'];
    const errorIndicators = ['error', 'failed', 'rejected', 'reverted', 'denied', 'insufficient', 'expired', 'timeout', 'mismatch', 'limit', 'invalid'];
    const hasSuccess = successIndicators.some(s => msg.includes(s));
    const hasError = errorIndicators.some(e => msg.includes(e));
    return hasSuccess && !hasError;
  }

  private perceive(error: Error, context?: Record<string, unknown>): FailureClassification {
    if (this.shouldSkipPerceive(error)) {
      return {
        code: 'unknown', category: 'unknown', severity: 'low',
        platform: 'unknown', details: `Skipped: message appears to indicate success: ${error.message}`,
        timestamp: Date.now(),
      };
    }
    for (const adapter of this.adapters) {
      const result = adapter.perceive(error, context);
      if (result) {
        const rc = getRootCause(result.code, result.category);
        if (rc) result.rootCauseHint = rc.hint;
        return result;
      }
    }
    const embeddingMatch = matchErrorSignature(error.message);
    if (embeddingMatch && embeddingMatch.similarity >= 0.5) {
      return {
        code: embeddingMatch.failureCode as ErrorCode,
        category: embeddingMatch.failureCategory as FailureCategory,
        severity: 'medium',
        platform: 'unknown',
        details: error.message,
        timestamp: Date.now(),
        rootCauseHint: `Embedding match (${(embeddingMatch.similarity * 100).toFixed(0)}%): ${embeddingMatch.matchedSignature.join(' + ')}`,
      };
    }
    // Meta-learning: match against learned patterns (before LLM)
    const metaMatch = this.metaLearner.matchPattern(error.message);
    if (metaMatch && metaMatch.confidence > 0.7) {
      return {
        code: (metaMatch.patternId || 'meta-matched') as ErrorCode,
        category: 'unknown' as FailureCategory,
        severity: 'medium',
        platform: 'unknown',
        details: error.message,
        timestamp: Date.now(),
        rootCauseHint: `Meta-learning match: ${metaMatch.strategy} (${(metaMatch.confidence * 100).toFixed(0)}%)`,
      };
    }
    return {
      code: 'unknown', category: 'unknown', severity: 'medium',
      platform: 'unknown', details: error.message, timestamp: Date.now(),
    };
  }

  private constructCandidates(failure: FailureClassification, context?: RepairContext): RepairCandidate[] {
    const candidates: RepairCandidate[] = [];
    for (const adapter of this.adapters) {
      candidates.push(...adapter.construct(failure, context));
    }
    return candidates.map((c) => ({
      ...c,
      successProbability: this.geneMap.getSuccessRate(failure.code, c.strategy),
    }));
  }

  private async verify(
    failure: FailureClassification,
    candidate: RepairCandidate,
    commitResult: CommitResult,
  ): Promise<boolean> {
    if (!commitResult.success) return false;

    // Mutative strategies should produce overrides
    const mutative = ['refresh_nonce', 'switch_network', 'reduce_request',
      'fix_params', 'switch_endpoint', 'extend_deadline'];
    if (mutative.includes(candidate.strategy)) {
      if (Object.keys(commitResult.overrides).length === 0 &&
          !commitResult.description.includes('MOCK')) {
        return false;
      }
    }

    // Cost ceiling check
    if (candidate.estimatedCostUsd > (this.options.maxRepairCostUsd ?? Infinity)) {
      return false;
    }

    return true;
  }

  async repair(error: Error, context?: Record<string, unknown>): Promise<RepairResult> {
    const start = Date.now();
    const mode: HelixMode = this.options.mode ?? 'auto';
    const refineCtx = createRefinementContext(error.message, this.options.maxRetries ?? 3);

    // Safety: prevent infinite cycles
    this.cycleCount++;
    if (this.cycleCount > this.MAX_CYCLES) {
      this.cycleCount = 0;
      const failure = this.perceive(error, context);
      bus.emit('error', this.agentId, { reason: 'MAX_CYCLES_EXCEEDED', cycles: this.MAX_CYCLES });
      return makeResult({ failure, explanation: `PCEC halted after ${this.MAX_CYCLES} cycles`, mode });
    }

    const span = this.otel.startRepairSpan(error.message);

    // ── Build RepairContext for context-aware Gene Map ──
    const repairContext: RepairContext = {
      chainId: context?.chainId as number | undefined,
      gasPriceGwei: context?.gasPrice ? Number(context.gasPrice) / 1e9 : undefined,
      hourOfDay: new Date().getHours(),
      agentId: this.agentId,
    };

    // ── PERCEIVE ──
    let failure = this.perceive(error, context);

    // ── LLM FALLBACK (only if perceive returned unknown + LLM enabled) ──
    if (failure.code === 'unknown' && this.options.llm?.enabled) {
      try {
        const { llmClassify } = await import('./llm.js');
        const fewShot = this.promptOptimizer.buildFewShotPrompt();
        const llmResult = await llmClassify(error.message, this.options.llm, fewShot || undefined);
        if (llmResult && llmResult.code !== 'unknown') {
          failure = llmResult;
          const rc = getRootCause(failure.code, failure.category);
          if (rc) failure.rootCauseHint = rc.hint;
          // DSPy: record LLM classification for prompt optimization
          this.promptOptimizer.record({
            errorMessage: error.message,
            predictedCode: failure.code,
            predictedCategory: failure.category,
            predictedStrategy: 'unknown',
            actualOutcome: 'unknown',
          });
        }
      } catch { /* LLM failed, continue with unknown */ }
    }

    this.otel.addStageEvent(span, 'perceive', { code: failure.code, category: failure.category });
    bus.emit('perceive', this.agentId, {
      code: failure.code, category: failure.category,
      severity: failure.severity, platform: failure.platform,
      details: failure.details, llmClassified: failure.llmClassified,
    });

    // ── Causal Graph: record occurrence + causation ──
    this.causalGraph.recordOccurrence(failure.code, failure.category, this.agentId);
    this.causalGraph.recordCausation(failure.code, failure.category);

    // ── D6: Systematic failure detection ──
    const systematicWarning = this.checkSystematic(failure);
    if (systematicWarning) {
      bus.emit('error', this.agentId, { reason: 'SYSTEMATIC', message: systematicWarning });
      this.options.onSystematic?.(systematicWarning, failure);
    }

    // ── OPT-5: Co-occurrence tracking for Gene Links ──
    const now = Date.now();
    this.recentFailures = this.recentFailures.filter(f => now - f.timestamp < 60_000);
    for (const recent of this.recentFailures) {
      if (recent.code !== failure.code || recent.category !== failure.category) {
        this.geneMap.recordCoOccurrence(recent.code, recent.category, failure.code, failure.category);
      }
    }
    this.recentFailures.push({ code: failure.code, category: failure.category, timestamp: now });

    // ── GENE MAP LOOKUP (context-aware Q-value ranking) ──
    const existingGene = this.geneMap.lookup(failure.code, failure.category, repairContext);
    if (existingGene && existingGene.qValue > 0.3) {
      this.stats.immuneHits++;
      this.stats.repairs++;
      const revenue = REVENUE_AT_RISK[failure.category] ?? 50;
      this.stats.savedRevenue += revenue;

      if (!existingGene.platforms.includes(failure.platform)) {
        existingGene.platforms.push(failure.platform);
        this.geneMap.addPlatform(failure.code, failure.category, failure.platform);
      }

      const explanation = `IMMUNE: Gene '${existingGene.strategy}' found ` +
        `(q=${existingGene.qValue.toFixed(2)}, ${existingGene.successCount} fixes). ` +
        `Platforms: ${existingGene.platforms.join(', ')}`;

      this.otel.addStageEvent(span, 'immune', { strategy: existingGene.strategy, qValue: existingGene.qValue });
      bus.emit('immune', this.agentId, {
        code: failure.code, category: failure.category,
        strategy: existingGene.strategy, successCount: existingGene.successCount,
        platforms: existingGene.platforms, crossPlatform: existingGene.platforms.length > 1,
      });

      if (mode === 'observe') {
        const totalMs = Date.now() - start;
        this.otel.endRepairSpan(span, { success: true, immune: true, strategy: existingGene.strategy, code: failure.code, category: failure.category, totalMs, qValue: existingGene.qValue });
        this.otel.recordRepair({ success: true, immune: true, strategy: existingGene.strategy, code: failure.code, durationMs: totalMs });
        this.geneMap.recordAudit({ agentId: this.agentId, errorMessage: error.message, failureCode: failure.code, failureCategory: failure.category, strategy: existingGene.strategy, immune: true, success: true, mode, durationMs: totalMs, qBefore: existingGene._originalQValue ?? existingGene.qValue });
        return makeResult({
          success: true, immune: true, mode, explanation, failure,
          gene: existingGene, totalMs,
          revenueProtected: revenue,
        });
      }

      // Auto/Full mode: execute the immune strategy (chain-aware)
      let commitResult: CommitResult;
      let stepsExecuted: { strategy: string; success: boolean; ms: number }[] | undefined;

      if (isChainStrategy(existingGene.strategy)) {
        const chainResult = await executeChain(this.provider,
          parseChainSteps(existingGene.strategy), failure, context,
        );
        commitResult = chainResult.commitResult;
        stepsExecuted = chainResult.stepsExecuted;
      } else {
        commitResult = await this.provider.execute(existingGene.strategy, failure, context);
      }

      const verified = await this.verify(
        failure,
        { strategy: existingGene.strategy, estimatedCostUsd: 0 } as RepairCandidate,
        commitResult,
      );

      if (verified) {
        this.geneMap.recordSuccess(failure.code, failure.category, Date.now() - start, repairContext);
      } else {
        this.geneMap.recordFailure(failure.code, failure.category, repairContext);
      }

      // Async LLM reasoning for immune genes with empty reasoning
      if (this.options.llm?.enabled && verified && existingGene.successCount >= 3 && (!existingGene.reasoning || existingGene.reasoning.length < 20)) {
        const fc = failure.code, fcat = failure.category, strat = existingGene.strategy, llmOpts = this.options.llm;
        import('./llm.js').then(({ llmGenerateReasoning }) => {
          llmGenerateReasoning(error.message, strat, llmOpts).then(r => {
            if (r && r.length > 10) this.geneMap.updateReasoning(fc, fcat, r);
          }).catch(() => {});
        }).catch(() => {});
      }

      // ── Predictive Failure Graph (immune path) ──
      if (this.lastFailure) {
        const delay = Date.now() - this.lastFailure.timestamp;
        if (delay < 60_000) {
          this.geneMap.recordTransition(this.lastFailure.code, this.lastFailure.category, failure.code, failure.category, delay);
        }
      }
      this.lastFailure = { code: failure.code, category: failure.category, timestamp: Date.now() };
      const immunePredictions = this.geneMap.predictNext(failure.code, failure.category);
      for (const pred of immunePredictions) {
        this.geneMap.preload(pred.code as any, pred.category as any);
      }

      this.cycleCount = 0;
      const immuneTotalMs = Date.now() - start;
      this.otel.endRepairSpan(span, { success: verified, immune: true, strategy: existingGene.strategy, code: failure.code, category: failure.category, totalMs: immuneTotalMs, qValue: existingGene.qValue });
      this.otel.recordRepair({ success: verified, immune: true, strategy: existingGene.strategy, code: failure.code, durationMs: immuneTotalMs });
      this.geneMap.recordAudit({ agentId: this.agentId, errorMessage: error.message, failureCode: failure.code, failureCategory: failure.category, strategy: existingGene.strategy, immune: true, success: verified, mode, durationMs: immuneTotalMs, qBefore: existingGene._originalQValue ?? existingGene.qValue, chainSteps: isChainStrategy(existingGene.strategy) ? existingGene.strategy.split('+') : undefined, predictions: immunePredictions.length > 0 ? immunePredictions.map(p => ({ code: p.code, probability: p.probability })) : undefined });

      const immuneWinner: RepairCandidate = {
        id: existingGene.strategy, strategy: existingGene.strategy,
        description: `Immune: ${existingGene.strategy}`,
        estimatedCostUsd: 0, estimatedSpeedMs: Date.now() - start,
        requirements: [], score: 100, successProbability: 0.99,
        platform: failure.platform,
      };
      if (isChainStrategy(existingGene.strategy)) {
        immuneWinner.steps = parseChainSteps(existingGene.strategy);
      }
      return makeResult({
        success: verified, immune: true, mode, verified,
        explanation: explanation + (verified ? '\n✓ Verified' : '\n✗ Verification failed'),
        failure, gene: existingGene,
        winner: immuneWinner,
        totalMs: Date.now() - start, revenueProtected: revenue,
        commitOverrides: commitResult.overrides,
        stepsExecuted,
        predictions: immunePredictions.length > 0 ? immunePredictions : undefined,
      });
    }

    // ── REGISTRY QUERY (cross-agent procedural memory) ──
    // Reached only when local Gene Map missed or had low confidence (the
    // immune-path block above returns early on qValue > 0.3). 200ms hard
    // timeout — on timeout/error we fall through to adapter+LLM as if
    // Registry weren't configured. Hit becomes a synthetic RepairCandidate
    // marked source='registry' and is prepended to the candidate list so
    // Evaluate sees it ahead of adapter-built candidates.
    let registryCandidate: import('./types.js').RepairCandidate | null = null;
    if (this.registryCfg) {
      this.registryQueryCount++;
      const result = await queryRegistry(this.registryCfg, failure.code, failure.category, failure.platform);
      if (result.outcome === 'hit' && result.capsule) {
        this.registryQueryHits++;
        registryCandidate = registryCapsuleToCandidate(result.capsule, failure);
      } else if (result.outcome === 'timeout') {
        this.registryQueryTimeouts++;
      }
    }

    // ── CONSTRUCT ──
    let candidates = this.constructCandidates(failure, context as RepairContext | undefined);
    if (registryCandidate) candidates.unshift(registryCandidate);

    // ── LLM CONSTRUCT FALLBACK (when no adapter has strategies) ──
    if (candidates.length === 0 && this.options.llm?.enabled) {
      this.llmConstructCalls++;
      try {
        const { llmConstructCandidates } = await import('./llm.js');
        // Trace-aware: pull last 3 same-code (then same-category fill) repair-audit
        // rows for THIS agent so the LLM sees prior attempts + outcomes, not just
        // the bare error code. See engine/llm.ts:buildConstructPrompt.
        const traces = this.geneMap.getRecentTraces(failure.code, failure.category, this.agentId, 3);
        const llmCandidates = await llmConstructCandidates(failure, error.message, this.options.llm, traces);
        if (llmCandidates && llmCandidates.length > 0) {
          candidates = llmCandidates;
          if (this.options.verbose) {
            console.log(`\x1b[35m[helix] LLM suggested ${candidates.length} strategies: ${candidates.map(c => c.strategy).join(', ')}\x1b[0m`);
          }
        }
      } catch { /* LLM failed */ }
    }

    // ── CHAIN DETECTION: compound errors ──
    candidates = detectStrategyChain(error.message, candidates);

    // ── FILTER: blocklist/allowlist ──
    const skippedStrategies: string[] = [];
    // Self-Refine: avoid strategies that already failed in this repair session
    const avoidStrategies = (context as any)?._avoidStrategies as string[] | undefined;
    if (avoidStrategies?.length) {
      const before = candidates.length;
      candidates = candidates.filter(c => !avoidStrategies.includes(c.strategy));
      if (candidates.length < before) {
        const excluded = avoidStrategies.filter(s => !candidates.some(c => c.strategy === s));
        excluded.forEach(s => skippedStrategies.push(`${s} (Self-Refine: already failed)`));
      }
      // If ALL candidates were filtered, restore originals
      if (candidates.length === 0 && before > 0) {
        candidates = this.constructCandidates(failure);
      }
    }
    if (this.options.blockStrategies?.length) {
      candidates = candidates.filter(c => {
        if (this.options.blockStrategies!.includes(c.strategy)) {
          skippedStrategies.push(c.strategy);
          return false;
        }
        return true;
      });
    }

    // ── FILTER: provider capability ──
    candidates = candidates.filter(c => {
      if (!this.provider.canExecute(c.strategy)) {
        skippedStrategies.push(`${c.strategy} (no provider)`);
        return false;
      }
      return true;
    });

    // ── FILTER: cost ceiling ──
    const maxCost = this.options.maxRepairCostUsd ?? Infinity;
    candidates = candidates.filter(c => {
      if (c.estimatedCostUsd > maxCost) {
        skippedStrategies.push(`${c.strategy} (cost $${c.estimatedCostUsd} > ceiling $${maxCost})`);
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      // Fallback: always offer at least a retry strategy
      candidates.push({
        id: 'fallback_retry', strategy: 'retry', description: 'Fallback retry',
        estimatedCostUsd: 0, estimatedSpeedMs: 1000, requirements: [], score: 1,
        successProbability: 0.5, platform: failure.platform,
      });
    }

    bus.emit('construct', this.agentId, {
      category: failure.category, candidateCount: candidates.length,
      candidates: candidates.map(c => ({ id: c.id, strategy: c.strategy, platform: c.platform })),
    });

    // ── Self-Refine: filter out previously failed strategies ──
    const refinement = refine(refineCtx);
    candidates = filterCandidates(candidates, refinement.excludeStrategies);

    // ── EVALUATE ──
    const scored = evaluate(candidates, failure);
    // Apply anti-pattern penalties from Negative Knowledge
    for (const c of scored) {
      const penalty = this.negativeKnowledge.getPenalty(failure.code, failure.category, c.strategy);
      if (penalty < 1.0) c.score = Math.round(c.score * penalty);
      // Conditional genes: context-aware multiplier
      const condMul = getConditionMultiplier((c as any).conditions || '{}', (c as any).anti_conditions || '{}', { platform: failure.platform });
      if (condMul < 1.0) c.score = Math.round(c.score * condMul);
    }
    // Apply adaptive weights (category-specific dimension weighting)
    try {
      const weights = this.adaptiveWeights.getWeights(failure.category);
      for (const c of scored) {
        // Re-weight based on learned dimension importance
        const boost = weights.accuracy * 0.5 + weights.safety * 0.5; // simple blend
        c.score = Math.round(c.score * (0.8 + 0.4 * boost));
      }
    } catch {}
    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0];
    this.otel.addStageEvent(span, 'evaluate', { winner: winner.strategy, score: winner.score });
    bus.emit('evaluate', this.agentId, {
      winner: winner.strategy, score: winner.score, platform: winner.platform,
      allScores: scored.map(c => ({ strategy: c.strategy, score: c.score })),
    });

    // ── BUILD EXPLANATION (with root cause hints OPT-7) ──
    const rootCause = getRootCause(failure.code, failure.category);
    const explanation = [
      `Perceived: ${failure.code} → ${failure.category} [${failure.severity}] (${failure.platform})`,
      rootCause ? `Root cause: ${rootCause.likelyCause}` : '',
      rootCause ? `Suggested: ${rootCause.suggestedAction}` : '',
      rootCause?.isLikelySystematic ? '⚠️ Likely systematic — check configuration.' : '',
      `Candidates: ${scored.map(c => `${c.strategy}(${c.score})`).join(', ')}`,
      `Selected: ${winner.strategy} (score: ${winner.score})`,
      skippedStrategies.length > 0 ? `Skipped: ${skippedStrategies.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    // ── OBSERVE MODE: return recommendation ──
    if (mode === 'observe') {
      return makeResult({
        success: true, mode, explanation, failure,
        candidates: scored, winner, costEstimate: winner.estimatedCostUsd,
        skippedStrategies,
      });
    }

    // ── AUTO MODE: block fund movement strategies ──
    if (mode === 'auto' && FUND_MOVEMENT_STRATEGIES.includes(winner.strategy)) {
      return makeResult({
        failure, mode, candidates: scored, winner,
        explanation: explanation + `\n⚠️ Strategy '${winner.strategy}' requires 'full' mode for fund movement.`,
        costEstimate: winner.estimatedCostUsd, skippedStrategies,
      });
    }

    // ── IDEMPOTENCY CHECK (D5) ──
    const inProgress = this.geneMap.checkRepairInProgress(failure.code, failure.category);
    if (inProgress.inProgress) {
      return makeResult({
        success: !!inProgress.txHash, mode, failure, candidates: scored, winner,
        explanation: explanation + `\nIdempotency: repair already ${inProgress.txHash ? 'completed' : 'in progress'} (${inProgress.repairId})`,
        verified: !!inProgress.txHash,
        costEstimate: winner.estimatedCostUsd, skippedStrategies,
      });
    }

    // ── SAFETY VERIFICATION (pre-commit) ──
    const safetyCheck = this.safetyVerifier.verify(winner.strategy, {}, {
      mode: mode, originalArgs: [], strategy: winner.strategy, overrides: {},
    });
    if (!safetyCheck.safe) {
      this.negativeKnowledge.record(failure.code, failure.category, winner.strategy, `Safety blocked: ${safetyCheck.violations[0]}`);
    }

    // ── COMMIT ──
    const repairId = this.geneMap.generateRepairId();
    this.geneMap.logRepairStart(repairId, failure.code, failure.category, winner.strategy);

    let commitResult: CommitResult;
    let stepsExecuted: { strategy: string; success: boolean; ms: number }[] | undefined;

    if (winner.steps && winner.steps.length > 0) {
      const chainResult = await executeChain(this.provider, winner.steps, failure, context);
      commitResult = chainResult.commitResult;
      stepsExecuted = chainResult.stepsExecuted;
    } else {
      commitResult = await this.provider.execute(winner.strategy, failure, context);
    }

    const totalMs = Date.now() - start;
    const revenue = REVENUE_AT_RISK[failure.category] ?? 50;

    this.otel.addStageEvent(span, 'commit', { success: commitResult.success });
    bus.emit('commit', this.agentId, {
      success: commitResult.success, strategy: winner.strategy,
      description: commitResult.description, totalMs,
    });

    // ── VERIFY (OPT-2: SAGE paper) ──
    const verified = await this.verify(failure, winner, commitResult);
    bus.emit('verify', this.agentId, { verified, strategy: winner.strategy });

    if (verified) {
      this.stats.repairs++;
      this.stats.savedRevenue += revenue;
      // Telemetry: track successful repair
      import('./telemetry.js').then(({ trackRepair }) => {
        trackRepair({ errorCode: failure.code, repairApplied: winner.strategy, success: true, platform: failure.platform, chain: (context?.chainId as number)?.toString() });
      }).catch(() => {});
      // DSPy: update LLM classification outcome
      if (failure.llmClassified) {
        this.promptOptimizer.updateOutcome(error.message, winner.strategy, true);
      }
      this.cycleCount = 0;
      recordAttempt(refineCtx, winner.strategy, false, undefined, totalMs);

      const txHash = commitResult.overrides.txHash as string | undefined;
      this.geneMap.logRepairComplete(repairId, txHash);

      const gene: GeneCapsule = {
        failureCode: failure.code, category: failure.category,
        strategy: winner.strategy, params: commitResult.overrides,
        successCount: 1, avgRepairMs: totalMs,
        platforms: [failure.platform],
        qValue: 0.6, consecutiveFailures: 0,
      };
      this.geneMap.store(gene);
      this.geneMap.recordSuccess(failure.code, failure.category, totalMs, repairContext);

      // Multi-dimensional scoring
      const scores = computeRepairScore({
        perceiveSource: failure.llmClassified ? 'llm' : 'adapter',
        costUsd: winner.estimatedCostUsd,
        repairMs: totalMs,
        mode,
        platformCount: gene.platforms.length,
      });
      this.geneMap.updateScores(failure.code, failure.category, scores.dimensions);

      // Meta-learning: learn patterns from successful repair
      this.metaLearner.learnPattern(error.message);
      // Adaptive weights: update dimension weights based on outcome
      this.adaptiveWeights.update(failure.category, { ...scores.dimensions, cost: scores.dimensions.costEfficiency } as any, true);
      // Conditional genes: update conditions on success
      try { const storedGene = this.geneMap.lookup(failure.code, failure.category); if (storedGene?.id) updateGeneConditions(this.geneMap.database, storedGene.id, { platform: failure.platform }, true); } catch {}

      bus.emit('gene', this.agentId, {
        code: failure.code, category: failure.category,
        strategy: winner.strategy, platform: failure.platform,
      });
      bus.emit('stats', this.agentId, {
        totalRepairs: this.stats.repairs, savedRevenue: this.stats.savedRevenue,
        immuneHits: this.stats.immuneHits, geneCount: this.geneMap.immuneCount(),
      });

      // ── Async LLM Reasoning (fire and forget) ──
      if (this.options.llm?.enabled) {
        const storedGene = this.geneMap.lookup(failure.code, failure.category);
        if (storedGene && storedGene.successCount >= 3 && (!storedGene.reasoning || storedGene.reasoning.length < 20)) {
          const fc = failure.code, fcat = failure.category, strat = winner.strategy;
          const llmOpts = this.options.llm;
          import('./llm.js').then(({ llmGenerateReasoning }) => {
            llmGenerateReasoning(error.message, strat, llmOpts).then(reasoning => {
              if (reasoning && reasoning.length > 10) {
                this.geneMap.updateReasoning(fc, fcat, reasoning);
                bus.emit('gene', this.agentId, { type: 'reasoning', code: fc, category: fcat, strategy: strat, reasoning });
              }
            }).catch(() => {});
          }).catch(() => {});
        }
      }

      // ── Telemetry: only report LLM-discovered repairs (new knowledge) ──
      if (this.options.telemetry?.enabled && (failure as any).llmClassified) {
        import('./telemetry.js').then(({ reportDiscovery }) => {
          reportDiscovery({
            errorMessage: error.message, code: failure.code, category: failure.category,
            severity: failure.severity, strategy: winner.strategy,
            qValue: gene.qValue ?? 0.5, source: (failure as any).llmClassified ? 'llm' : 'adapter',
            reasoning: (failure as any).llmReasoning, llmProvider: this.options.llm?.provider,
            platform: failure.platform,
          }, this.options.telemetry!);
        }).catch(() => {});
      }

      // OPT-4: Update context + OPT-10: Attribution
      this.geneMap.updateContext(failure.code, failure.category, true, { chain: (context?.chainId as number)?.toString(), platform: failure.platform });
      this.geneMap.recordAttribution({ repairId, agentId: this.agentId, stepId: context?.stepId as string, workflow: context?.workflow as string, failureCode: failure.code, category: failure.category, strategy: winner.strategy, success: true });

      const attribution = { agentId: this.agentId, stepId: context?.stepId as string, workflow: context?.workflow as string, timestamp: Date.now() };

      // ── Predictive Failure Graph: record transition + predict + preload ──
      if (this.lastFailure) {
        const delay = Date.now() - this.lastFailure.timestamp;
        if (delay < 60_000) {
          this.geneMap.recordTransition(this.lastFailure.code, this.lastFailure.category, failure.code, failure.category, delay);
        }
      }
      this.lastFailure = { code: failure.code, category: failure.category, timestamp: Date.now() };

      const predictions = this.geneMap.predictNext(failure.code, failure.category);
      for (const pred of predictions) {
        this.geneMap.preload(pred.code as any, pred.category as any);
      }

      this.otel.endRepairSpan(span, { success: true, immune: false, strategy: winner.strategy, code: failure.code, category: failure.category, totalMs, qValue: gene.qValue });
      this.otel.recordRepair({ success: true, immune: false, strategy: winner.strategy, code: failure.code, durationMs: totalMs });
      this.geneMap.recordAudit({ agentId: this.agentId, errorMessage: error.message, failureCode: failure.code, failureCategory: failure.category, strategy: winner.strategy, immune: false, success: true, mode, durationMs: totalMs, qBefore: existingGene?.qValue, overrides: commitResult.overrides, chainSteps: winner.steps?.map(s => s.strategy), predictions: predictions.length > 0 ? predictions.map(p => ({ code: p.code, probability: p.probability })) : undefined });

      // ── REGISTRY SYNC (fire-and-forget) ──
      // Push the just-committed capsule to Gene Registry Cloud so other
      // agents on this code can inherit the strategy. Never blocks the
      // PCEC return path. Only fires for non-immune commit-success (we
      // skip immune re-pushes and never push failures).
      if (this.registryCfg?.writeKey) {
        const justCommitted = this.geneMap.lookup(failure.code, failure.category);
        if (justCommitted) {
          this.registrySyncCount++;
          pushCapsuleToRegistry(this.registryCfg, justCommitted, {
            platform: failure.platform,
            chainId: typeof context?.chainId === 'number' ? context.chainId : undefined,
            sdkVersion: 'helix-core/2.7.x',
          }).then(ok => { if (!ok) this.registrySyncFailures++; })
            .catch(() => { this.registrySyncFailures++; });
        }
      }

      return makeResult({
        success: true, mode, verified: true,
        explanation: explanation + '\n✓ Verified',
        failure, candidates: scored, winner,
        gene: this.geneMap.lookup(failure.code, failure.category) ?? gene,
        totalMs, revenueProtected: revenue,
        costEstimate: winner.estimatedCostUsd, skippedStrategies,
        attribution,
        commitOverrides: commitResult.overrides,
        stepsExecuted,
        predictions: predictions.length > 0 ? predictions : undefined,
      });
    }

    // Verify failed
    recordAttempt(refineCtx, winner.strategy, true, commitResult.description, Date.now() - start);
    // Telemetry: track failed repair
    import('./telemetry.js').then(({ trackRepair }) => {
      trackRepair({ errorCode: failure.code, repairApplied: winner.strategy, success: false, platform: failure.platform, chain: (context?.chainId as number)?.toString() });
    }).catch(() => {});
    // DSPy: update LLM classification outcome
    if (failure.llmClassified) {
      this.promptOptimizer.updateOutcome(error.message, winner.strategy, false);
    }
    this.geneMap.logRepairFailed(repairId);
    this.geneMap.updateContext(failure.code, failure.category, false, { chain: (context?.chainId as number)?.toString(), platform: failure.platform });
    this.geneMap.recordFailureAnalysis(failure.code, failure.category, `Strategy '${winner.strategy}' failed: ${commitResult.description}`);
    this.geneMap.recordAttribution({ repairId, agentId: this.agentId, stepId: context?.stepId as string, workflow: context?.workflow as string, failureCode: failure.code, category: failure.category, strategy: winner.strategy, success: false });
    if (existingGene) {
      this.geneMap.recordFailure(failure.code, failure.category, repairContext);
    }

    // ── Failure Learning: record + maybe distill defensive Gene ──
    this.geneMap.recordFailedRepair({
      failureCode: failure.code, category: failure.category,
      strategy: winner.strategy, error: error.message,
      repairError: commitResult.description,
      context: repairContext,
    });
    maybeDistillFromFailures(this.geneMap, failure.code, winner.strategy);
    this.negativeKnowledge.record(failure.code, failure.category, winner.strategy, commitResult.description);
    // Adaptive weights: update on failure
    try {
      const failScores = computeRepairScore({ perceiveSource: 'adapter', costUsd: winner.estimatedCostUsd, repairMs: totalMs, mode });
      this.adaptiveWeights.update(failure.category, { ...failScores.dimensions, cost: failScores.dimensions.costEfficiency } as any, false);
      // Conditional genes: update on failure
      try { const sg = this.geneMap.lookup(failure.code, failure.category); if (sg?.id) updateGeneConditions(this.geneMap.database, sg.id, { platform: failure.platform }, false); } catch {}
    } catch {}

    this.otel.endRepairSpan(span, { success: false, immune: false, strategy: winner.strategy, code: failure.code, category: failure.category, totalMs });
    this.otel.recordRepair({ success: false, immune: false, strategy: winner.strategy, code: failure.code, durationMs: totalMs });
    this.geneMap.recordAudit({ agentId: this.agentId, errorMessage: error.message, failureCode: failure.code, failureCategory: failure.category, strategy: winner.strategy, immune: false, success: false, mode, durationMs: totalMs, qBefore: existingGene?.qValue });

    return makeResult({
      failure, mode, candidates: scored, winner, totalMs,
      explanation: explanation + '\n✗ Verification failed',
      costEstimate: winner.estimatedCostUsd, skippedStrategies,
      attribution: { agentId: this.agentId, stepId: context?.stepId as string, workflow: context?.workflow as string, timestamp: Date.now() },
    });
  }

  getStats() {
    return {
      ...this.stats,
      geneCount: this.geneMap.immuneCount(),
      genes: this.geneMap.list(),
    };
  }

  getGeneMap(): GeneMap {
    return this.geneMap;
  }

  getABTests(): ABTest[] {
    return this.abTests.getAllTests();
  }
}
