import { bus } from './bus.js';
import { GeneMap } from './gene-map.js';
import { PcecEngine } from './pcec.js';
import type { RepairResult, WrapOptions } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { defaultAdapters } from '../platforms/index.js';
import { detectSignature, applyOverrides } from './auto-detect.js';
import { createLogger } from './logger.js';
import { refine, createRefinementContext, recordAttempt, filterCandidates } from './self-refine.js';

let _defaultEngine: PcecEngine | null = null;
let _defaultGeneMap: GeneMap | null = null;

export function createEngine(options?: WrapOptions): PcecEngine {
  const geneMap = new GeneMap(options?.geneMapPath ?? options?.config?.geneMapPath ?? DEFAULT_CONFIG.geneMapPath);
  const engine = new PcecEngine(geneMap, options?.agentId ?? options?.config?.projectName ?? 'default', options);
  for (const adapter of defaultAdapters) {
    if (!options?.platforms || options.platforms.includes(adapter.name) || adapter.name === 'generic') engine.registerAdapter(adapter);
  }
  return engine;
}

// Cache engines by geneMapPath to allow shared Gene Maps
const _engineCache = new Map<string, { engine: PcecEngine; geneMap: GeneMap }>();

function getDefaultEngine(options?: WrapOptions): { engine: PcecEngine; geneMap: GeneMap } {
  const dbPath = options?.geneMapPath ?? options?.config?.geneMapPath ?? DEFAULT_CONFIG.geneMapPath;
  const cached = _engineCache.get(dbPath);
  if (cached) return cached;

  const geneMap = new GeneMap(dbPath);
  const engine = new PcecEngine(geneMap, options?.agentId ?? 'default', options);
  for (const adapter of defaultAdapters) {
    if (!options?.platforms || options.platforms.includes(adapter.name) || adapter.name === 'generic') engine.registerAdapter(adapter);
  }
  _engineCache.set(dbPath, { engine, geneMap });
  return { engine, geneMap };
}

const SIMPLE_RETRY = ['backoff_retry', 'retry', 'retry_with_receipt'];

export function wrap<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options?: WrapOptions,
): (...args: TArgs) => Promise<TResult> {
  const maxRetries = options?.maxRetries ?? options?.config?.maxRetries ?? DEFAULT_CONFIG.maxRetries;
  const agentId = options?.agentId ?? 'wrapped';
  const log = createLogger({ logger: options?.logger, logLevel: options?.logLevel, logFormat: options?.logFormat, verbose: options?.verbose });

  return async (...args: TArgs): Promise<TResult> => {
    const startTime = Date.now();
    const enabled = typeof options?.enabled === 'function' ? options.enabled() : (options?.enabled ?? true);
    if (!enabled) return fn(...args);

    const freezeArgs = options?.freezeArgs === true;
    let currentArgs = args;
    let lastRepairResult: RepairResult | null = null;
    const refineCtx = createRefinementContext((args as any)?.[0]?.toString?.() ?? '', maxRetries);
    let lastStrategy: string | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn(...currentArgs);
        if (attempt > 0) {
          // Business-level verify: check that the result is correct, not just successful
          if (options?.verify && lastRepairResult) {
            try {
              const isValid = await options.verify(result, args as unknown[]);
              if (!isValid) {
                log.warn('Business verification failed — repair result rejected', {
                  strategy: lastRepairResult.winner?.strategy,
                });
                // Record as failure in Gene Map (q_value decreases)
                const { engine } = getDefaultEngine(options);
                engine.getGeneMap().recordFailure(
                  lastRepairResult.failure.code,
                  lastRepairResult.failure.category,
                );
                const verifyError = new Error(
                  `Helix repair succeeded but business verification failed. ` +
                  `Strategy: ${lastRepairResult.winner?.strategy ?? lastRepairResult.gene?.strategy}.`
                );
                (verifyError as any)._helix = {
                  ...lastRepairResult,
                  verifyFailed: true,
                  repaired: false,
                };
                throw verifyError;
              }
            } catch (verifyErr: any) {
              if (verifyErr._helix?.verifyFailed) throw verifyErr;
              log.error('verify() callback threw an error', { error: verifyErr.message });
              const { engine } = getDefaultEngine(options);
              engine.getGeneMap().recordFailure(
                lastRepairResult.failure.code,
                lastRepairResult.failure.category,
              );
              verifyErr._helixVerifyError = true;
              throw verifyErr;
            }
          }
          // For primitive results (string tx hashes), don't use Object.assign which creates a String object
          if (typeof result === 'string' || typeof result === 'number' || typeof result === 'bigint') {
            return result;
          }
          return Object.assign(result as object, { _helix: { repaired: true, attempts: attempt + 1, totalMs: Date.now() - startTime } }) as TResult;
        }
        return result;
      } catch (error) {
        // Business verify failure — exit immediately, don't re-enter PCEC
        if ((error as any)?._helix?.verifyFailed || (error as any)?._helixVerifyError) throw error;

        // Self-Refine: record failed attempt and check if we should continue
        if (lastStrategy) {
          const errMsg = (error as any)?.shortMessage ?? (error as Error).message ?? String(error);
          recordAttempt(refineCtx, lastStrategy, true, errMsg.substring(0, 200), Date.now() - startTime);
          lastStrategy = null;

          const refinement = refine(refineCtx);
          if (!refinement.shouldContinue) {
            log.error(`Self-Refine: stopping — ${refinement.reason}`, { attempts: refineCtx.attemptHistory.length });
            throw error;
          }
          log.info(`Self-Refine: ${refinement.reason}`);
        }

        if (attempt === maxRetries) {
          log.error('All repair attempts exhausted', { attempts: maxRetries });
          throw error;
        }

        try {
          const { engine } = getDefaultEngine(options);
          const errMsg = (error as any)?.shortMessage ?? (error as Error).message ?? String(error);
          const wrappedError = error instanceof Error ? error : new Error(errMsg);

          log.info('Payment failed, engaging PCEC', { attempt: attempt + 1, maxRetries });
          bus.emit('retry', agentId, { attempt: attempt + 1, maxRetries });

          // Self-Refine: get exclude list from refinement context
          const refinement = refine(refineCtx);

          const result: RepairResult = await engine.repair(wrappedError, {
            ...options?.context,
            allowPartial: options?.allowPartial ?? (options?.context as Record<string, unknown> | undefined)?.allowPartial,
            chainId: (error as any)?.chain?.id,
            walletAddress: (error as any)?.account?.address,
            _avoidStrategies: refinement.excludeStrategies.length > 0 ? refinement.excludeStrategies : undefined,
          });
          lastRepairResult = result;

          if (result.success) options?.onRepair?.(result);
          else options?.onFailure?.(result);

          // Observe mode — diagnosis only
          if (result.mode === 'observe') {
            const enriched = error as Error & { _helix: RepairResult; helixRecommendation: RepairResult };
            enriched._helix = result;
            enriched.helixRecommendation = result;
            throw enriched;
          }

          const strategy = result.winner?.strategy ?? result.gene?.strategy;
          if (!strategy) {
            log.warn('No viable strategy');
            recordAttempt(refineCtx, 'none', true, 'no viable strategy', Date.now() - startTime);
            continue; // next attempt
          }

          // Self-Refine: track which strategy we're about to try
          lastStrategy = strategy;

          log.info(result.immune ? `IMMUNE via ${strategy}` : `REPAIRED via ${strategy}`, { ms: result.totalMs, immune: result.immune });

          // freezeArgs: no strategy may auto-mutate args. parameterModifier
          // (handled below) remains the only authoritative way to change them.
          if (freezeArgs && (strategy === 'renew_session' || strategy === 'split_transaction')) {
            log.debug(`freezeArgs: skipping arg-mutating strategy '${strategy}' — retrying with original args`);
            continue;
          }

          // ── renew_session: call sessionRefresher ──
          if (strategy === 'renew_session' && options?.sessionRefresher) {
            try {
              const refreshed = await options.sessionRefresher();
              const newTokens = typeof refreshed === 'string' ? { authorization: `Bearer ${refreshed}` } : refreshed;
              const sig = detectSignature(currentArgs as unknown[]);
              if (sig.type === 'fetch' && currentArgs.length >= 2) {
                const init = { ...(currentArgs[1] as Record<string, unknown> || {}) };
                init.headers = { ...(init.headers as Record<string, unknown> || {}), ...newTokens };
                currentArgs = [currentArgs[0], init] as TArgs;
              } else if (sig.type !== 'unknown' && typeof currentArgs[0] === 'object') {
                currentArgs = [{ ...(currentArgs[0] as Record<string, unknown>), ...newTokens }, ...currentArgs.slice(1)] as TArgs;
              }
              log.info('Session refreshed via sessionRefresher');
            } catch { log.warn('sessionRefresher failed, retrying with original args'); }
            continue;
          }

          // ── split_transaction: split value/amount into N parts ──
          if (strategy === 'split_transaction') {
            const parts = options?.splitConfig?.parts ?? 2;
            const delayMs = options?.splitConfig?.delayMs ?? 1000;
            const sig = detectSignature(currentArgs as unknown[]);

            if (sig.type === 'viem-tx') {
              const tx = currentArgs[0] as Record<string, unknown>;
              const val = tx.value as bigint | undefined;
              if (val && val > 0n) {
                const partVal = val / BigInt(parts);
                log.info(`Splitting tx into ${parts} parts of ${partVal}`);
                let lastResult: TResult | undefined;
                for (let i = 0; i < parts; i++) {
                  try {
                    lastResult = await fn(...([{ ...tx, value: partVal }, ...currentArgs.slice(1)] as TArgs));
                    if (i < parts - 1) await new Promise(r => setTimeout(r, delayMs));
                  } catch { log.warn(`Split part ${i + 1}/${parts} failed`); }
                }
                if (lastResult !== undefined) return lastResult;
              }
            } else if (sig.type === 'generic-payment') {
              // L1 guard: only split a SCALAR numeric amount. Array/object/
              // ambiguous amounts (e.g. Circle's `amount: string[]`) must not
              // be divided — skip split and fall through to retry-as-is.
              if (sig.amountShape === 'number' || sig.amountShape === 'numeric-string') {
                const p = currentArgs[0] as Record<string, unknown>;
                const amt = Number(p.amount);
                if (Number.isFinite(amt) && amt > 0) {
                  const partAmt = amt / parts;
                  // Preserve the original scalar shape (string stays a string).
                  const partVal: unknown = sig.amountShape === 'numeric-string' ? String(partAmt) : partAmt;
                  log.info(`Splitting payment into ${parts} parts of ${String(partVal)}`);
                  let lastResult: TResult | undefined;
                  for (let i = 0; i < parts; i++) {
                    try {
                      lastResult = await fn(...([{ ...p, amount: partVal }, ...currentArgs.slice(1)] as TArgs));
                      if (i < parts - 1) await new Promise(r => setTimeout(r, delayMs));
                    } catch { log.warn(`Split part ${i + 1}/${parts} failed`); }
                  }
                  if (lastResult !== undefined) return lastResult;
                }
              }
            }
            continue; // fallback: retry as-is
          }

          // Apply overrides for non-simple strategies
          if (!SIMPLE_RETRY.includes(strategy)) {
            const overrides = result.commitOverrides ?? {};

            // Priority 1: User parameterModifier — authoritative, allowed even
            // under freezeArgs (the caller is explicitly controlling mutation).
            if (options?.parameterModifier && Object.keys(overrides).length > 0) {
              currentArgs = options.parameterModifier(currentArgs as unknown[], overrides, strategy) as TArgs;
              log.info('Applied overrides via parameterModifier');
            }
            // Priority 2: Auto-detect — bypassed entirely when freezeArgs is set.
            else if (freezeArgs) {
              log.debug(`freezeArgs: skipping auto-detect override for '${strategy}' — retrying with original args`);
            }
            else {
              const sig = detectSignature(currentArgs as unknown[]);
              const applied = applyOverrides([...currentArgs] as unknown[], overrides, strategy, sig);
              if (applied) {
                currentArgs = applied as TArgs;
                log.info(`Auto-applied overrides (${sig.type})`, { strategy, keys: Object.keys(overrides) });
              }
            }
          }
          // For simple retry: apply exponential backoff for backoff_retry
          if (strategy === 'backoff_retry') {
            const backoffMs = Math.min(1000 * Math.pow(2, attempt), 16000);
            await new Promise(r => setTimeout(r, backoffMs));
          }
        } catch (helixError) {
          if ((helixError as any)?._helix || (helixError as any)?.helixRecommendation) throw helixError;
          options?.onHelixError?.(helixError as Error);
          throw error;
        }
      }
    }
    throw new Error('Helix: unexpected repair loop exit');
  };
}

export function shutdown(): void {
  for (const { geneMap } of _engineCache.values()) {
    try { geneMap.close(); } catch {}
  }
  _engineCache.clear();
}
