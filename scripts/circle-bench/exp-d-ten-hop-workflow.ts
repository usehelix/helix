/**
 * Experiment D — 10-hop Agent Commerce Workflow.
 *
 * N=50 workflows × 10 hops. Each hop is a real agent commerce step:
 *   1. GET /item   from mock x402 seller (may 503 at FAIL_RATE)
 *   2. createTransaction on Arc Testnet via Circle SDK
 *   3. POST /item to confirm delivery (may 503 at FAIL_RATE)
 *
 *   Bare:  give up on first failure in any hop.
 *   Helix: retry up to 3× per failing step with 500ms backoff on
 *          seller_timeout (HTTP 503) or Circle rate-limit (code:5).
 *
 * Expected:
 *   Bare  ≈ 0.95^10 ≈ 59.9% (compounding 5% per-hop failure)
 *   Helix ≈ 90-95%
 *
 * Run:
 *   MODE=bare  npx tsx --env-file=.env exp-d-ten-hop-workflow.ts
 *   MODE=helix npx tsx --env-file=.env exp-d-ten-hop-workflow.ts
 *   npx tsx   --env-file=.env exp-d-ten-hop-workflow.ts --both
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

// ── Config ─────────────────────────────────────────────────────────────
const N_WORKFLOWS = parseInt(process.env.N_WORKFLOWS ?? "50", 10);
const N_HOPS = parseInt(process.env.N_HOPS ?? "10", 10);
const FAIL_RATE = parseFloat(process.env.FAIL_RATE ?? "0.05");
const AMOUNT_USDC = "0.001";
const HELIX_MAX_RETRIES = 3;
const HELIX_BACKOFF_MS = 500;
const BETWEEN_MODE_SLEEP_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;
const PROGRESS_EVERY = 10;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const RESULTS_DIR = path.join(PROJECT_ROOT, "experiment-results");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Env ────────────────────────────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

const SELLER_URL = requireEnv("SELLER_URL_EXP_D");
const apiKey = requireEnv("CIRCLE_API_KEY");
const entitySecret = requireEnv("CIRCLE_ENTITY_SECRET");
const walletId = requireEnv("CIRCLE_WALLET_ID");
const destinationAddress = requireEnv("CIRCLE_SECOND_WALLET_ADDRESS");
const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

// ── Types ──────────────────────────────────────────────────────────────
type Step = "get_item" | "circle_pay" | "post_item";

interface HopResult {
  hop_index: number;
  success: boolean;
  failure_step?: Step;
  failure_kind?: "seller_timeout" | "circle_rate_limit" | "circle_other" | "other";
  failure_message?: string;
  attempts: number;
  tx_id?: string;
  duration_ms: number;
}

interface WorkflowResult {
  workflow_index: number;
  mode: "bare" | "helix";
  e2e_success: boolean;
  hops_completed: number;
  hops: HopResult[];
  duration_ms: number;
}

interface RoundResult {
  mode: "bare" | "helix";
  startedAt: string;
  endedAt: string;
  n_workflows: number;
  n_hops: number;
  fail_rate: number;
  workflows: WorkflowResult[];
  summary: {
    e2e_success_count: number;
    e2e_success_rate: number;
    hops_attempted: number;
    hops_succeeded: number;
    total_attempts: number;
    error_breakdown: Record<string, number>;
    p50_workflow_ms: number;
    p99_workflow_ms: number;
  };
}

// ── Token id ──────────────────────────────────────────────────────────
async function resolveUsdcTokenId(): Promise<string> {
  const balRes = await client.getWalletTokenBalance({ id: walletId });
  const balances = balRes.data?.tokenBalances ?? [];
  const usdc = balances.find((b: any) => b.token?.symbol === "USDC");
  if (!usdc?.token?.id) throw new Error("USDC tokenId not found on source wallet");
  return usdc.token.id;
}

// ── Classify failures ─────────────────────────────────────────────────
function classifySellerError(status: number, body: any): {
  kind: HopResult["failure_kind"];
  message: string;
} {
  const code = body?.code;
  const error = body?.error;
  if (status === 503 || code === "ETIMEOUT" || error === "seller_timeout") {
    return { kind: "seller_timeout", message: `${status}: ${error ?? "seller_timeout"}` };
  }
  return { kind: "other", message: `${status}: ${error ?? "unknown"}` };
}

function classifyCircleError(err: any): {
  kind: HopResult["failure_kind"];
  message: string;
} {
  const code = err?.response?.data?.code ?? err?.code;
  const status = err?.response?.status ?? err?.status;
  const msg = (err?.response?.data?.message ?? err?.message ?? String(err)).slice(0, 200);
  if (code === 5 || status === 429 || /rate limit/i.test(msg)) {
    return { kind: "circle_rate_limit", message: msg };
  }
  return { kind: "circle_other", message: msg };
}

const isRetryable = (kind: HopResult["failure_kind"]) =>
  kind === "seller_timeout" || kind === "circle_rate_limit";

// ── Per-step primitives ───────────────────────────────────────────────
async function getItem(): Promise<{ ok: true; item: any } | { ok: false; status: number; body: any }> {
  const url = `${SELLER_URL}/item?fail_rate=${FAIL_RATE}`;
  const res = await fetch(url, { method: "GET" });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, item: body };
  return { ok: false, status: res.status, body };
}

async function postItem(): Promise<{ ok: true; body: any } | { ok: false; status: number; body: any }> {
  const url = `${SELLER_URL}/item?fail_rate=${FAIL_RATE}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, body };
  return { ok: false, status: res.status, body };
}

async function pollTx(txId: string): Promise<any> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const r = await client.getTransaction({ id: txId });
    const t = r.data?.transaction;
    const state = t?.state ?? "UNKNOWN";
    if (state === "COMPLETE" || state === "CONFIRMED") return t;
    if (state === "FAILED" || state === "DENIED" || state === "CANCELLED")
      throw new Error(`terminal ${state}: ${t?.errorReason ?? "unknown"}`);
  }
  throw new Error("polling timeout");
}

async function circlePayOnce(tokenId: string): Promise<{ ok: true; txId: string } | { ok: false; err: any }> {
  try {
    const r = await client.createTransaction({
      walletId,
      destinationAddress,
      tokenId,
      amounts: [AMOUNT_USDC],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const txId = r.data?.id;
    if (!txId) return { ok: false, err: new Error("createTransaction returned no id") };
    await pollTx(txId);
    return { ok: true, txId };
  } catch (err) {
    return { ok: false, err };
  }
}

// ── Run one hop ───────────────────────────────────────────────────────
async function runHop(
  hopIndex: number,
  mode: "bare" | "helix",
  tokenId: string,
): Promise<HopResult> {
  const start = Date.now();
  let attempts = 0;
  let txId: string | undefined;

  // Step 1 — GET /item (retryable in helix on seller_timeout)
  for (let t = 0; t < (mode === "helix" ? HELIX_MAX_RETRIES + 1 : 1); t++) {
    attempts++;
    const r = await getItem();
    if (r.ok) break;
    const cls = classifySellerError(r.status, r.body);
    if (mode === "helix" && isRetryable(cls.kind) && t < HELIX_MAX_RETRIES) {
      await sleep(HELIX_BACKOFF_MS);
      continue;
    }
    return {
      hop_index: hopIndex,
      success: false,
      failure_step: "get_item",
      failure_kind: cls.kind,
      failure_message: cls.message,
      attempts,
      duration_ms: Date.now() - start,
    };
  }

  // Step 2 — Circle createTransaction + poll (retryable in helix on rate_limit)
  for (let t = 0; t < (mode === "helix" ? HELIX_MAX_RETRIES + 1 : 1); t++) {
    attempts++;
    const r = await circlePayOnce(tokenId);
    if (r.ok) {
      txId = r.txId;
      break;
    }
    const cls = classifyCircleError(r.err);
    if (mode === "helix" && isRetryable(cls.kind) && t < HELIX_MAX_RETRIES) {
      await sleep(HELIX_BACKOFF_MS);
      continue;
    }
    return {
      hop_index: hopIndex,
      success: false,
      failure_step: "circle_pay",
      failure_kind: cls.kind,
      failure_message: cls.message,
      attempts,
      tx_id: undefined,
      duration_ms: Date.now() - start,
    };
  }

  // Step 3 — POST /item (retryable in helix on seller_timeout)
  for (let t = 0; t < (mode === "helix" ? HELIX_MAX_RETRIES + 1 : 1); t++) {
    attempts++;
    const r = await postItem();
    if (r.ok) {
      return {
        hop_index: hopIndex,
        success: true,
        attempts,
        tx_id: txId,
        duration_ms: Date.now() - start,
      };
    }
    const cls = classifySellerError(r.status, r.body);
    if (mode === "helix" && isRetryable(cls.kind) && t < HELIX_MAX_RETRIES) {
      await sleep(HELIX_BACKOFF_MS);
      continue;
    }
    return {
      hop_index: hopIndex,
      success: false,
      failure_step: "post_item",
      failure_kind: cls.kind,
      failure_message: cls.message,
      attempts,
      tx_id: txId,
      duration_ms: Date.now() - start,
    };
  }

  // unreachable
  return {
    hop_index: hopIndex,
    success: false,
    failure_step: "post_item",
    failure_kind: "other",
    failure_message: "unreachable",
    attempts,
    tx_id: txId,
    duration_ms: Date.now() - start,
  };
}

// ── Run one workflow ──────────────────────────────────────────────────
async function runWorkflow(
  index: number,
  mode: "bare" | "helix",
  tokenId: string,
): Promise<WorkflowResult> {
  const start = Date.now();
  const hops: HopResult[] = [];
  for (let h = 0; h < N_HOPS; h++) {
    const hop = await runHop(h, mode, tokenId);
    hops.push(hop);
    if (!hop.success) break; // both modes: give up on first hop failure
  }
  const e2e = hops.length === N_HOPS && hops.every((h) => h.success);
  return {
    workflow_index: index,
    mode,
    e2e_success: e2e,
    hops_completed: hops.filter((h) => h.success).length,
    hops,
    duration_ms: Date.now() - start,
  };
}

// ── Run a round (N_WORKFLOWS) ─────────────────────────────────────────
async function runRound(mode: "bare" | "helix", tokenId: string): Promise<RoundResult> {
  const startedAt = new Date().toISOString();
  const workflows: WorkflowResult[] = [];
  const errorBreakdown: Record<string, number> = {};
  let hopsAttempted = 0;
  let hopsSucceeded = 0;
  let totalAttempts = 0;

  console.log(`\n  Running ${N_WORKFLOWS} workflows (mode=${mode})...`);

  for (let i = 0; i < N_WORKFLOWS; i++) {
    const w = await runWorkflow(i, mode, tokenId);
    workflows.push(w);
    hopsAttempted += w.hops.length;
    hopsSucceeded += w.hops.filter((h) => h.success).length;
    totalAttempts += w.hops.reduce((s, h) => s + h.attempts, 0);
    if (!w.e2e_success) {
      const failing = w.hops.find((h) => !h.success);
      if (failing?.failure_kind) {
        const key = `${failing.failure_step}/${failing.failure_kind}`;
        errorBreakdown[key] = (errorBreakdown[key] ?? 0) + 1;
      }
    }
    if ((i + 1) % PROGRESS_EVERY === 0) {
      const succ = workflows.filter((x) => x.e2e_success).length;
      const rate = ((succ / (i + 1)) * 100).toFixed(1);
      console.log(`    [${i + 1}/${N_WORKFLOWS}] running E2E success: ${rate}%`);
    }
  }

  const successCount = workflows.filter((w) => w.e2e_success).length;
  const durations = workflows.map((w) => w.duration_ms).sort((a, b) => a - b);
  const p = (q: number) =>
    durations[Math.min(durations.length - 1, Math.floor(durations.length * q))];

  return {
    mode,
    startedAt,
    endedAt: new Date().toISOString(),
    n_workflows: N_WORKFLOWS,
    n_hops: N_HOPS,
    fail_rate: FAIL_RATE,
    workflows,
    summary: {
      e2e_success_count: successCount,
      e2e_success_rate: (successCount / N_WORKFLOWS) * 100,
      hops_attempted: hopsAttempted,
      hops_succeeded: hopsSucceeded,
      total_attempts: totalAttempts,
      error_breakdown: errorBreakdown,
      p50_workflow_ms: p(0.5),
      p99_workflow_ms: p(0.99),
    },
  };
}

function printRound(r: RoundResult) {
  const label = r.mode === "bare" ? "WITHOUT Helix" : "WITH Helix";
  const { summary } = r;
  console.log("\n" + "=".repeat(55));
  console.log(`  ${label} — N=${r.n_workflows} × ${r.n_hops} hops, fail_rate=${r.fail_rate}`);
  console.log("=".repeat(55));
  console.log(
    `  E2E success rate:  ${summary.e2e_success_rate.toFixed(1)}% (${summary.e2e_success_count}/${r.n_workflows})`,
  );
  console.log(`  Hops succeeded:    ${summary.hops_succeeded}/${summary.hops_attempted}`);
  console.log(`  Total attempts:    ${summary.total_attempts}`);
  console.log(`  p50 workflow:      ${summary.p50_workflow_ms} ms`);
  console.log(`  p99 workflow:      ${summary.p99_workflow_ms} ms`);
  if (Object.keys(summary.error_breakdown).length > 0) {
    console.log(`  First-failure breakdown (workflow-level):`);
    for (const [k, v] of Object.entries(summary.error_breakdown).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(30)} ${v}`);
    }
  }
  console.log("=".repeat(55));
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const args = process.argv.slice(2);
  const runBoth = args.includes("--both");
  const requestedMode = (process.env.MODE ?? "bare") as "bare" | "helix";

  console.log("\n🔬 Experiment D — 10-hop Agent Commerce Workflow");
  console.log(`   N_WORKFLOWS=${N_WORKFLOWS}  N_HOPS=${N_HOPS}  FAIL_RATE=${FAIL_RATE}`);
  console.log(`   Theoretical bare expectation: ${((0.95 ** N_HOPS) * 100).toFixed(1)}%  (= (1-fail_rate)^hops compounding)`);
  console.log(`   Seller: ${SELLER_URL}\n`);

  const tokenId = await resolveUsdcTokenId();
  console.log(`   USDC tokenId: ${tokenId}`);

  const rounds: RoundResult[] = [];

  if (runBoth || requestedMode === "bare") {
    const round = await runRound("bare", tokenId);
    printRound(round);
    rounds.push(round);

    if (runBoth) {
      console.log(`\n  Cooldown ${BETWEEN_MODE_SLEEP_MS / 1000}s before Helix...`);
      await sleep(BETWEEN_MODE_SLEEP_MS);
    }
  }

  if (runBoth || requestedMode === "helix") {
    const round = await runRound("helix", tokenId);
    printRound(round);
    rounds.push(round);
  }

  // A/B comparison
  if (rounds.length === 2) {
    const bare = rounds.find((r) => r.mode === "bare")!;
    const hlx = rounds.find((r) => r.mode === "helix")!;
    const theoretical = (1 - FAIL_RATE) ** N_HOPS * 100;
    const delta = hlx.summary.e2e_success_rate - bare.summary.e2e_success_rate;
    console.log("\n" + "=".repeat(55));
    console.log("  A/B COMPARISON — FOR THE DECK");
    console.log("─".repeat(55));
    console.log(`  Theoretical bare:   ${theoretical.toFixed(1)}%  (${(1 - FAIL_RATE).toFixed(2)}^${N_HOPS}, compounding)`);
    console.log(`  Measured bare:      ${bare.summary.e2e_success_rate.toFixed(1)}% (${bare.summary.e2e_success_count}/${bare.n_workflows})`);
    console.log(`  Measured Helix:     ${hlx.summary.e2e_success_rate.toFixed(1)}% (${hlx.summary.e2e_success_count}/${hlx.n_workflows})`);
    console.log(`  Delta:              ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp`);
    console.log(`  N: ${N_WORKFLOWS} workflows × ${N_HOPS} hops`);
    console.log("=".repeat(55));
  }

  const outFile = path.join(RESULTS_DIR, `exp-d-ten-hop-${TIMESTAMP}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        meta: {
          timestamp: TIMESTAMP,
          experiment: "D — 10-hop agent commerce workflow",
          source: "scripts/circle-bench/exp-d-ten-hop-workflow.ts",
          seller_url: SELLER_URL,
          n_workflows: N_WORKFLOWS,
          n_hops: N_HOPS,
          fail_rate: FAIL_RATE,
          theoretical_bare_pct: (1 - FAIL_RATE) ** N_HOPS * 100,
          helix_max_retries: HELIX_MAX_RETRIES,
          helix_backoff_ms: HELIX_BACKOFF_MS,
        },
        rounds,
      },
      null,
      2,
    ),
  );
  console.log(`\n  💾 Saved: ${outFile}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
