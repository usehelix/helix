import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverService, verifyDelivery, SellerError } from "./seller-client";
import { payForService, CircleError } from "./circle-client";
import { emitHopEvent } from "./telemetry";
import { runHelixHop } from "./helix-wrap";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const runsDir = path.join(projectRoot, "runs");

const MAX_ACCEPTABLE_PRICE_USDC = 0.01;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic [0,1) draw from a 32-bit seed. */
function mulberry32Draw(rawSeed: number): number {
  let s = rawSeed | 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Deterministic per-hop think delay seeded by (workflowIndex, hopIndex).
 * Same indices → same delay across bare and helix arms.
 */
export function thinkDelayFor(
  workflowIndex: number,
  hopIndex: number,
  range: [number, number],
): number {
  const [lo, hi] = range;
  if (hi <= lo) return Math.max(0, lo);
  const r = mulberry32Draw(workflowIndex * 1000 + hopIndex);
  return Math.floor(lo + r * (hi - lo));
}

/**
 * Deterministic per-hop 503 injection seeded by (workflowIndex, hopIndex).
 * XOR with a distinct constant to decorrelate from thinkDelayFor.
 * Same indices → same 503 outcome across bare and helix arms.
 */
export function shouldInject503(
  workflowIndex: number,
  hopIndex: number,
  failRate: number,
): boolean {
  if (failRate <= 0) return false;
  if (failRate >= 1) return true;
  const r = mulberry32Draw((workflowIndex * 1000 + hopIndex) ^ 0xdeadbeef);
  return r < failRate;
}

export interface HopSeeds {
  thinkDelayMs: number;
  inject503: boolean;
}

export type Mode = "bare" | "helix";
export type FailStep = "discover" | "estimate" | "pay" | "verify";

export interface StepDurations {
  discover_ms?: number;
  estimate_ms?: number;
  pay_ms?: number;
  verify_ms?: number;
}

export interface HopResult {
  hop_index: number;
  outcome: "success" | "failure";
  tx_id?: string;
  tx_hash?: string;
  price_usdc?: string;
  failure_step?: FailStep;
  failure_reason?: string;
  duration_ms: number;
  /** Per-step timing; only steps that ran are populated. */
  step_durations?: StepDurations;
  /** Elapsed from quote receipt to verify submission. Core stale indicator. */
  quote_age_at_verify_ms?: number;
  /** Random think delay sampled for this hop (deterministic from workflow+hop index). */
  think_delay_ms?: number;
  /** True if 503 was client-side injected (seeded) for this hop. */
  injected_503?: boolean;
  // ── Helix-mode only ──
  preflight_applied?: boolean;
  preflight_note?: string;
  /** Helix only: did preflight defer discover until after think? */
  late_discover_applied?: boolean;
}

export interface WorkflowResult {
  workflow_id: string;
  mode: Mode;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  e2e_success: boolean;
  hops: HopResult[];
  usdc_paid_onchain: string;
  usdc_paid_succeeded: string;
  wasted_usdc: string;
}

export async function runHop(
  hopIndex: number,
  workflowId: string,
  mode: Mode,
  ttlMs: number | undefined,
  seeds: HopSeeds,
): Promise<HopResult> {
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

  try {
    // Bare order: discover → estimate → THINK → pay → verify
    // The agent fetches a quote eagerly, then "thinks" (LLM inference latency),
    // then pays. If think + pay > TTL, the quote stales at verify.
    failureStep = "discover";
    if (seeds.inject503) {
      throw new SellerError("discover 503: service unavailable (seeded)", "discover");
    }
    const tDiscover = Date.now();
    const quote = await discoverService(hopIndex, 0, ttlMs);
    stepDurations.discover_ms = Date.now() - tDiscover;
    quoteReceivedAt = Date.now();
    quoteExpiresAt = quote.expires_at;
    price = quote.price_usdc;

    failureStep = "estimate";
    const tEstimate = Date.now();
    const priceNum = parseFloat(quote.price_usdc);
    if (!Number.isFinite(priceNum) || priceNum <= 0 || priceNum > MAX_ACCEPTABLE_PRICE_USDC) {
      throw new Error(
        `quote price ${quote.price_usdc} outside accepted range (0, ${MAX_ACCEPTABLE_PRICE_USDC}]`,
      );
    }
    stepDurations.estimate_ms = Date.now() - tEstimate;

    if (seeds.thinkDelayMs > 0) await sleep(seeds.thinkDelayMs);

    failureStep = "pay";
    const tPay = Date.now();
    const pay = await payForService({ price_usdc: quote.price_usdc });
    stepDurations.pay_ms = Date.now() - tPay;
    txId = pay.tx_id;
    txHash = pay.tx_hash;

    failureStep = "verify";
    quoteAgeAtVerifyMs = Date.now() - quoteReceivedAt;
    const tVerify = Date.now();
    const verify = await verifyDelivery(pay.tx_id, hopIndex, quoteExpiresAt);
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

  const result: HopResult = {
    hop_index: hopIndex,
    outcome,
    tx_id: txId,
    tx_hash: txHash,
    price_usdc: price,
    failure_step: failureStep,
    failure_reason: failureReason,
    duration_ms,
    step_durations: stepDurations,
    quote_age_at_verify_ms: quoteAgeAtVerifyMs,
    think_delay_ms: seeds.thinkDelayMs,
    injected_503: seeds.inject503,
  };

  emitHopEvent({
    workflow_id: workflowId,
    hop_index: hopIndex,
    mode,
    outcome,
    tx_hash: txHash,
    failure_reason: failureReason,
    duration_ms,
  });

  return result;
}

export async function runWorkflow(
  workflowId: string,
  nHops: number,
  mode: Mode,
  failRate: number,
  ttlMs: number | undefined,
  workflowIndex: number,
  thinkDelayRange: [number, number],
): Promise<WorkflowResult> {
  const started_at = new Date().toISOString();
  const start = Date.now();
  const hops: HopResult[] = [];

  for (let i = 0; i < nHops; i++) {
    const seeds: HopSeeds = {
      thinkDelayMs: thinkDelayFor(workflowIndex, i, thinkDelayRange),
      inject503: shouldInject503(workflowIndex, i, failRate),
    };
    const hop =
      mode === "helix"
        ? await runHelixHop(i, workflowId, ttlMs, seeds)
        : await runHop(i, workflowId, mode, ttlMs, seeds);
    hops.push(hop);
    if (hop.outcome === "failure") break;
  }

  const ended_at = new Date().toISOString();
  const duration_ms = Date.now() - start;
  const e2e_success = hops.length === nHops && hops.every((h) => h.outcome === "success");

  // Any hop with a tx_hash had USDC actually leave the wallet on-chain,
  // regardless of whether verify later rejected the delivery.
  const paidOnchain = hops
    .filter((h) => !!h.tx_hash)
    .reduce((acc, h) => acc + parseFloat(h.price_usdc ?? "0"), 0);
  const paidSucceeded = hops
    .filter((h) => h.outcome === "success")
    .reduce((acc, h) => acc + parseFloat(h.price_usdc ?? "0"), 0);
  const wasted = paidOnchain - paidSucceeded;

  const result: WorkflowResult = {
    workflow_id: workflowId,
    mode,
    started_at,
    ended_at,
    duration_ms,
    e2e_success,
    hops,
    usdc_paid_onchain: paidOnchain.toFixed(6),
    usdc_paid_succeeded: paidSucceeded.toFixed(6),
    wasted_usdc: wasted.toFixed(6),
  };

  if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, `${workflowId}.json`), JSON.stringify(result, null, 2));

  return result;
}
