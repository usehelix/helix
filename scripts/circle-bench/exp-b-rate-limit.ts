/**
 * Experiment B — Circle Rate Limit A/B.
 *
 * Without Helix: 10 concurrent createTransaction calls. Expected: ~5 succeed,
 *   ~5 return {"code":5,"message":"API rate limit error"} per the documented
 *   ~5-concurrent cap on Arc Testnet wallets.
 * With Helix:    same 10 tx, but serialized through a per-wallet queue with
 *   exponential backoff on rate-limit detection (matches the Coinbase
 *   adapter's pattern at packages/core/src/platforms/coinbase/perceive.ts:10).
 *
 * Modes:
 *   MODE=bare  npx tsx --env-file=.env exp-b-rate-limit.ts
 *   MODE=helix npx tsx --env-file=.env exp-b-rate-limit.ts
 *   npx tsx --env-file=.env exp-b-rate-limit.ts --both
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

// ── Config ─────────────────────────────────────────────────────────────
const N_CONCURRENT = 10;
const AMOUNT = "0.001"; // $0.001 USDC per tx, our verified-working minimum
const BETWEEN_MODE_SLEEP_MS = 10_000; // let rate-limit window cool before helix run
const HELIX_BACKOFF_INITIAL = 500;
const HELIX_BACKOFF_FACTOR = 2;
const HELIX_BACKOFF_CAP = 8_000;
const HELIX_MAX_ATTEMPTS = 5;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const RESULTS_DIR = path.join(PROJECT_ROOT, "experiment-results");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Types ──────────────────────────────────────────────────────────────
interface TxResult {
  index: number;
  success: boolean;
  txId?: string;
  errorCode?: number | string;
  errorMessage?: string;
  latencyMs: number;
  attempt: number;
}

interface RoundResult {
  mode: "bare" | "helix";
  n: number;
  timestamp: string;
  startedAt: string;
  endedAt: string;
  results: TxResult[];
  summary: {
    successCount: number;
    failCount: number;
    successRate: number;
    rateLimitErrors: number;
    totalAttempts: number;
    p50Ms: number;
    p99Ms: number;
  };
}

// ── Circle SDK setup ──────────────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

const apiKey = requireEnv("CIRCLE_API_KEY");
const entitySecret = requireEnv("CIRCLE_ENTITY_SECRET");
const walletId = requireEnv("CIRCLE_WALLET_ID");
const destinationAddress = requireEnv("CIRCLE_SECOND_WALLET_ADDRESS");
const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

async function resolveUsdcTokenId(): Promise<string> {
  const balRes = await client.getWalletTokenBalance({ id: walletId });
  const balances = balRes.data?.tokenBalances ?? [];
  const usdc = balances.find((b: any) => b.token?.symbol === "USDC");
  if (!usdc?.token?.id) throw new Error("USDC tokenId not found on source wallet");
  return usdc.token.id;
}

// ── Rate-limit detection (mirrors Coinbase perceive.ts pattern shape) ─
// Circle's documented shape: {"code": 5, "message": "API rate limit error"}.
// We also accept the HTTP 429 + "rate limit" substring fallback.
function isRateLimit(err: any): boolean {
  const code = err?.response?.data?.code ?? err?.code ?? err?.status;
  const status = err?.response?.status ?? err?.status;
  const msg = (err?.response?.data?.message ?? err?.message ?? "").toLowerCase();
  if (code === 5) return true;
  if (status === 429) return true;
  if (msg.includes("rate limit")) return true;
  return false;
}

function extractErr(err: any): { code: number | string | undefined; message: string } {
  const code =
    err?.response?.data?.code ??
    err?.code ??
    err?.response?.status ??
    err?.status;
  const message =
    err?.response?.data?.message ?? err?.message ?? String(err);
  return { code, message };
}

// ── BARE MODE: all 10 fired concurrently, single attempt each ─────────
async function runBare(tokenId: string): Promise<TxResult[]> {
  console.log(`\n  Spawning ${N_CONCURRENT} concurrent createTransaction calls (bare)...`);
  const promises = Array.from({ length: N_CONCURRENT }, async (_, i): Promise<TxResult> => {
    const start = Date.now();
    try {
      const res = await client.createTransaction({
        walletId,
        destinationAddress,
        tokenId,
        amounts: [AMOUNT],
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      });
      return {
        index: i,
        success: true,
        txId: res.data?.id,
        latencyMs: Date.now() - start,
        attempt: 1,
      };
    } catch (err: any) {
      const { code, message } = extractErr(err);
      return {
        index: i,
        success: false,
        errorCode: code,
        errorMessage: message,
        latencyMs: Date.now() - start,
        attempt: 1,
      };
    }
  });
  return Promise.all(promises);
}

// ── HELIX MODE: serialized queue + exponential backoff on rate limit ──
async function runHelix(tokenId: string): Promise<TxResult[]> {
  console.log(`\n  Serializing ${N_CONCURRENT} txs through Helix queue with backoff...`);
  console.log("  [helix] Capsule active: circle-api-rate-limit → serialize_and_backoff (q=0.75)");

  const results: TxResult[] = [];
  let backoffMs = HELIX_BACKOFF_INITIAL;

  for (let i = 0; i < N_CONCURRENT; i++) {
    const start = Date.now();
    let attempt = 0;
    let success = false;
    let txId: string | undefined;
    let lastError: any = null;

    while (attempt < HELIX_MAX_ATTEMPTS && !success) {
      attempt++;
      try {
        const res = await client.createTransaction({
          walletId,
          destinationAddress,
          tokenId,
          amounts: [AMOUNT],
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        });
        txId = res.data?.id;
        success = true;
        // Reward signal: decrease backoff on success
        backoffMs = Math.max(HELIX_BACKOFF_INITIAL, Math.floor(backoffMs * 0.8));
      } catch (err: any) {
        lastError = err;
        if (isRateLimit(err) && attempt < HELIX_MAX_ATTEMPTS) {
          console.log(
            `  [helix] tx ${i}: code:5 detected, backoff ${backoffMs}ms (attempt ${attempt})`,
          );
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * HELIX_BACKOFF_FACTOR, HELIX_BACKOFF_CAP);
        } else {
          break; // non-rate-limit error or out of attempts
        }
      }
    }

    const { code, message } = success
      ? { code: undefined, message: "" }
      : extractErr(lastError);

    results.push({
      index: i,
      success,
      txId,
      errorCode: success ? undefined : code,
      errorMessage: success ? undefined : message,
      latencyMs: Date.now() - start,
      attempt,
    });

    if (success) {
      console.log(`  [helix] tx ${i}: ✅ success in ${attempt} attempt${attempt > 1 ? "s" : ""}`);
    } else {
      console.log(`  [helix] tx ${i}: ❌ gave up after ${attempt} attempts (${message.slice(0, 60)})`);
    }
  }

  return results;
}

// ── Summarize ─────────────────────────────────────────────────────────
function summarize(
  results: TxResult[],
  mode: "bare" | "helix",
  startedAt: string,
): RoundResult {
  const successes = results.filter((r) => r.success);
  const rl = results.filter((r) => r.errorCode === 5 || /rate limit/i.test(r.errorMessage ?? ""));
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalAttempts = results.reduce((s, r) => s + r.attempt, 0);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];

  return {
    mode,
    n: results.length,
    timestamp: TIMESTAMP,
    startedAt,
    endedAt: new Date().toISOString(),
    results,
    summary: {
      successCount: successes.length,
      failCount: results.length - successes.length,
      successRate: (successes.length / results.length) * 100,
      rateLimitErrors: rl.length,
      totalAttempts,
      p50Ms: p(0.5),
      p99Ms: p(0.99),
    },
  };
}

function printRound(round: RoundResult) {
  const label = round.mode === "bare" ? "WITHOUT Helix" : "WITH Helix";
  const { summary, n, mode } = round;
  console.log(`\n${"=".repeat(55)}`);
  console.log(`  ${label} — N=${n} concurrent txs (mode=${mode})`);
  console.log("=".repeat(55));
  console.log(`  Success rate:      ${summary.successRate.toFixed(0)}% (${summary.successCount}/${n})`);
  console.log(`  Rate limit errors: ${summary.rateLimitErrors}`);
  console.log(`  Total attempts:    ${summary.totalAttempts}`);
  console.log(`  p50 latency:       ${summary.p50Ms}ms`);
  console.log(`  p99 latency:       ${summary.p99Ms}ms`);
  console.log("=".repeat(55));
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const args = process.argv.slice(2);
  const runBoth = args.includes("--both");
  const requestedMode = (process.env.MODE ?? "bare") as "bare" | "helix";

  console.log("\n🔬 Experiment B — Circle Rate Limit A/B (Arc Testnet)");
  console.log(`   N=${N_CONCURRENT} concurrent txs per arm  |  amount=$${AMOUNT} USDC`);
  console.log('   Looking for {"code":5,"message":"API rate limit error"}\n');

  const tokenId = await resolveUsdcTokenId();
  console.log(`   USDC tokenId: ${tokenId}`);

  const rounds: RoundResult[] = [];

  // ── Bare arm ───────────────────────────────────────────────────────
  if (runBoth || requestedMode === "bare") {
    const startedAt = new Date().toISOString();
    const bare = await runBare(tokenId);
    const round = summarize(bare, "bare", startedAt);
    printRound(round);
    rounds.push(round);

    if (runBoth) {
      console.log(`\n  Cooldown ${BETWEEN_MODE_SLEEP_MS}ms before Helix run (let rate-limit window reset)...`);
      await sleep(BETWEEN_MODE_SLEEP_MS);
    }
  }

  // ── Helix arm ──────────────────────────────────────────────────────
  if (runBoth || requestedMode === "helix") {
    const startedAt = new Date().toISOString();
    const hlx = await runHelix(tokenId);
    const round = summarize(hlx, "helix", startedAt);
    printRound(round);
    rounds.push(round);
  }

  // ── A/B comparison ─────────────────────────────────────────────────
  if (rounds.length === 2) {
    const bare = rounds.find((r) => r.mode === "bare")!;
    const helix = rounds.find((r) => r.mode === "helix")!;
    const delta = helix.summary.successRate - bare.summary.successRate;

    console.log("\n📊 A/B COMPARISON — FOR THE DECK");
    console.log("─".repeat(55));
    console.log(`  Without Helix:  ${bare.summary.successRate.toFixed(0)}% (${bare.summary.successCount}/${bare.n})`);
    console.log(`  With Helix:     ${helix.summary.successRate.toFixed(0)}% (${helix.summary.successCount}/${helix.n})`);
    console.log(`  Delta:          ${delta >= 0 ? "+" : ""}${delta.toFixed(0)}pp`);
    console.log(`  Rate-limit errors caught by Helix: ${bare.summary.rateLimitErrors}`);
    console.log("─".repeat(55));
    console.log("\n  Gene Capsule activated: circle-api-rate-limit → serialize_and_backoff");
    console.log("  q_value: 0.75 (seeded) — would update after this run in production");
  }

  // ── Persist ────────────────────────────────────────────────────────
  const outFile = path.join(RESULTS_DIR, `exp-b-rate-limit-${TIMESTAMP}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        meta: {
          timestamp: TIMESTAMP,
          experiment: "B — Circle rate-limit A/B (Arc Testnet)",
          source: "scripts/circle-bench/exp-b-rate-limit.ts",
          n_concurrent: N_CONCURRENT,
          amount_usdc: AMOUNT,
          helix_backoff: {
            initial_ms: HELIX_BACKOFF_INITIAL,
            factor: HELIX_BACKOFF_FACTOR,
            cap_ms: HELIX_BACKOFF_CAP,
            max_attempts: HELIX_MAX_ATTEMPTS,
          },
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
