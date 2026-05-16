import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { GeneMap, wrap } from "@vial-agent/core";
import { discoverService, verifyDelivery, SellerError } from "./seller-client";
import { payForService, CircleError } from "./circle-client";
import { emitHopEvent } from "./telemetry";
import type { HopResult, FailStep, StepDurations, HopSeeds } from "./workflow";

const AGENT_ID = "circle-bench-helix";
const FAILURE_CODE_STALE = "stale_quote";
const FAILURE_CATEGORY = "service";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "output");
if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
const dbPath = path.join(outputDir, "helix-genes.db");

const geneMap = new GeneMap(dbPath);

export interface HelixHopState {
  hopIndex: number;
  workflowId: string;
  ttlMs?: number;
  seeds: HopSeeds;
  /** Preflight-set flag: if true, defer discover until AFTER the think sleep. */
  lateDiscover: boolean;
  preflightNote?: string;
}

const MAX_ACCEPTABLE_PRICE_USDC = 0.01;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function preflight(
  args: unknown[],
): Promise<{ modifiedArgs?: unknown[]; note?: string }> {
  const [state] = args as [HelixHopState];
  const audit = geneMap.getAuditLog(50);
  const priorStale = audit.find((a) => a.failureCode === FAILURE_CODE_STALE);
  if (priorStale && !state.lateDiscover) {
    const next: HelixHopState = {
      ...state,
      lateDiscover: true,
      preflightNote: `audit has prior ${FAILURE_CODE_STALE}; deferring discover until after think`,
    };
    return { modifiedArgs: [next], note: next.preflightNote };
  }
  return {};
}

async function helixHopFn(state: HelixHopState): Promise<HopResult> {
  const start = Date.now();
  let failureStep: FailStep | undefined;
  let failureReason: string | undefined;
  let txId: string | undefined;
  let txHash: string | undefined;
  let price: string | undefined;
  let quoteReceivedAt: number | undefined;
  let quoteExpiresAt: string | undefined;
  let quoteAgeAtVerifyMs: number | undefined;
  const stepDurations: StepDurations = {};

  const doDiscover = async () => {
    if (state.seeds.inject503) {
      throw new SellerError(
        "discover 503: service unavailable (seeded)",
        "discover",
      );
    }
    const tDiscover = Date.now();
    const quote = await discoverService(state.hopIndex, 0, state.ttlMs);
    stepDurations.discover_ms = Date.now() - tDiscover;
    quoteReceivedAt = Date.now();
    quoteExpiresAt = quote.expires_at;
    price = quote.price_usdc;
    return quote;
  };

  const checkPrice = (priceUsdc: string) => {
    const tEstimate = Date.now();
    const priceNum = parseFloat(priceUsdc);
    if (
      !Number.isFinite(priceNum) ||
      priceNum <= 0 ||
      priceNum > MAX_ACCEPTABLE_PRICE_USDC
    ) {
      throw new Error(
        `quote price ${priceUsdc} outside accepted range (0, ${MAX_ACCEPTABLE_PRICE_USDC}]`,
      );
    }
    stepDurations.estimate_ms = Date.now() - tEstimate;
  };

  try {
    let quote;
    if (state.lateDiscover) {
      // Helix-learned order: THINK → discover → estimate → pay → verify
      // Quote is fresh because discover happens AFTER the slow LLM-think step.
      if (state.seeds.thinkDelayMs > 0) await sleep(state.seeds.thinkDelayMs);
      failureStep = "discover";
      quote = await doDiscover();
      failureStep = "estimate";
      checkPrice(quote.price_usdc);
    } else {
      // Bare-equivalent order: discover → estimate → THINK → pay → verify
      // Quote is signed early; think delay ages it before pay/verify.
      failureStep = "discover";
      quote = await doDiscover();
      failureStep = "estimate";
      checkPrice(quote.price_usdc);
      if (state.seeds.thinkDelayMs > 0) await sleep(state.seeds.thinkDelayMs);
    }

    failureStep = "pay";
    const tPay = Date.now();
    const pay = await payForService({ price_usdc: quote.price_usdc });
    stepDurations.pay_ms = Date.now() - tPay;
    txId = pay.tx_id;
    txHash = pay.tx_hash;

    failureStep = "verify";
    quoteAgeAtVerifyMs = Date.now() - (quoteReceivedAt ?? Date.now());
    const tVerify = Date.now();
    const verify = await verifyDelivery(pay.tx_id, state.hopIndex, quoteExpiresAt);
    stepDurations.verify_ms = Date.now() - tVerify;
    if (!verify.delivered) {
      throw new Error(`verify rejected: ${verify.reason ?? "unknown"}`);
    }

    failureStep = undefined;
  } catch (e) {
    if (e instanceof SellerError) {
      failureReason = `${e.name}(${e.step}): ${e.message}`;
    } else if (e instanceof CircleError) {
      failureReason = `${e.name}${e.state ? "(" + e.state + ")" : ""}: ${e.message}`;
    } else {
      failureReason = e instanceof Error ? e.message : String(e);
    }
  }

  const duration_ms = Date.now() - start;
  const outcome: HopResult["outcome"] = failureStep ? "failure" : "success";

  // Record stale_quote failures into vial-core audit so preflight can learn from them.
  if (outcome === "failure" && failureReason?.includes(FAILURE_CODE_STALE)) {
    try {
      geneMap.recordAudit({
        agentId: AGENT_ID,
        errorMessage: failureReason.slice(0, 500),
        failureCode: FAILURE_CODE_STALE,
        failureCategory: FAILURE_CATEGORY,
        strategy: "observe",
        immune: false,
        success: false,
        mode: "observe",
        durationMs: duration_ms,
      });
    } catch (recErr) {
      console.warn(
        "[helix] recordAudit failed:",
        recErr instanceof Error ? recErr.message : recErr,
      );
    }
  }

  const result: HopResult = {
    hop_index: state.hopIndex,
    outcome,
    tx_id: txId,
    tx_hash: txHash,
    price_usdc: price,
    failure_step: failureStep,
    failure_reason: failureReason,
    duration_ms,
    step_durations: stepDurations,
    quote_age_at_verify_ms: quoteAgeAtVerifyMs,
    think_delay_ms: state.seeds.thinkDelayMs,
    injected_503: state.seeds.inject503,
    preflight_applied: state.lateDiscover,
    preflight_note: state.preflightNote,
    late_discover_applied: state.lateDiscover,
  };

  emitHopEvent({
    workflow_id: state.workflowId,
    hop_index: state.hopIndex,
    mode: "helix",
    outcome,
    tx_hash: txHash,
    failure_reason: failureReason,
    duration_ms,
  });

  return result;
}

const wrappedHelixHop = wrap(helixHopFn, {
  agentId: AGENT_ID,
  maxRetries: 0,
  preflight,
});

export async function runHelixHop(
  hopIndex: number,
  workflowId: string,
  ttlMs: number | undefined,
  seeds: HopSeeds,
): Promise<HopResult> {
  const state: HelixHopState = {
    hopIndex,
    workflowId,
    ttlMs,
    seeds,
    lateDiscover: false,
  };
  return wrappedHelixHop(state);
}

export function closeHelixGeneMap(): void {
  try {
    geneMap.close();
  } catch {}
}

export function helixAuditSnapshot(): {
  total: number;
  staleQuoteCount: number;
} {
  const audit = geneMap.getAuditLog(1000);
  return {
    total: audit.length,
    staleQuoteCount: audit.filter((a) => a.failureCode === FAILURE_CODE_STALE)
      .length,
  };
}
