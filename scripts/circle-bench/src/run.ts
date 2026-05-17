import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkflow, type Mode, type WorkflowResult } from "./workflow";
import { getChainConfig, DEFAULT_CHAIN_KEY } from "./chain-config";
import { setChain } from "./circle-client";
import { runTransferExperiment, type TransferMode } from "./transfer";

type Experiment = "scenario1" | "transfer";

interface Args {
  experiment: Experiment;
  mode: Mode;
  nWorkflows: number;
  nHops: number;
  failRate: number;
  ttlMs?: number;
  thinkDelayRange: [number, number];
  chainKey: string;
  // transfer-only
  transferMode: TransferMode;
  nAgents: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    experiment: "scenario1",
    mode: "bare",
    nWorkflows: 50,
    nHops: 10,
    failRate: 0.05,
    thinkDelayRange: [0, 0],
    chainKey: DEFAULT_CHAIN_KEY,
    transferMode: "shared",
    nAgents: 50,
  };
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [k, vRaw] = raw.slice(2).split("=");
    const v = vRaw ?? "";
    switch (k) {
      case "experiment":
        if (v !== "scenario1" && v !== "transfer")
          throw new Error(`invalid --experiment: ${v}`);
        out.experiment = v;
        break;
      case "mode":
        if (v !== "bare" && v !== "helix") throw new Error(`invalid --mode: ${v}`);
        out.mode = v;
        break;
      case "transfer-mode":
        if (v !== "shared" && v !== "isolated")
          throw new Error(`invalid --transfer-mode: ${v}`);
        out.transferMode = v;
        break;
      case "n-workflows":
        out.nWorkflows = parseInt(v, 10);
        if (!Number.isFinite(out.nWorkflows) || out.nWorkflows < 1)
          throw new Error(`invalid --n-workflows: ${v}`);
        break;
      case "n-agents":
        out.nAgents = parseInt(v, 10);
        if (!Number.isFinite(out.nAgents) || out.nAgents < 1)
          throw new Error(`invalid --n-agents: ${v}`);
        break;
      case "n-hops":
        out.nHops = parseInt(v, 10);
        if (!Number.isFinite(out.nHops) || out.nHops < 1)
          throw new Error(`invalid --n-hops: ${v}`);
        break;
      case "fail-rate":
        out.failRate = parseFloat(v);
        if (!Number.isFinite(out.failRate) || out.failRate < 0 || out.failRate > 1)
          throw new Error(`invalid --fail-rate: ${v}`);
        break;
      case "ttl-ms":
        out.ttlMs = parseInt(v, 10);
        if (!Number.isFinite(out.ttlMs) || out.ttlMs < 1)
          throw new Error(`invalid --ttl-ms: ${v}`);
        break;
      case "think-delay-range": {
        const parts = v.split(",").map((s) => parseInt(s.trim(), 10));
        if (
          parts.length !== 2 ||
          !parts.every((n) => Number.isFinite(n) && n >= 0) ||
          parts[1] < parts[0]
        ) {
          throw new Error(`invalid --think-delay-range (need "lo,hi"): ${v}`);
        }
        out.thinkDelayRange = [parts[0], parts[1]];
        break;
      }
      case "chain":
        out.chainKey = v || DEFAULT_CHAIN_KEY;
        break;
      default:
        throw new Error(`unknown arg: --${k}`);
    }
  }
  return out;
}

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chain = getChainConfig(args.chainKey);
  setChain(chain);

  // Dispatch: transfer experiment runs entirely in transfer.ts.
  if (args.experiment === "transfer") {
    await runTransferExperiment({
      mode: args.transferMode,
      nAgents: args.nAgents,
      nHops: args.nHops,
      ttlMs: args.ttlMs,
      thinkDelayRange: args.thinkDelayRange,
      failRate: args.failRate,
      chain,
    });
    return;
  }

  console.log(
    `experiment=${args.experiment} chain=${chain.key} mode=${args.mode} n-workflows=${args.nWorkflows} n-hops=${args.nHops} fail-rate=${args.failRate}` +
      (args.ttlMs !== undefined ? ` ttl-ms=${args.ttlMs}` : "") +
      ` think-delay=[${args.thinkDelayRange[0]},${args.thinkDelayRange[1]}]ms`,
  );

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(__dirname, "..");
  const runsDir = path.join(projectRoot, "runs");
  if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });

  const started_at = new Date().toISOString();
  const startMs = Date.now();
  const results: WorkflowResult[] = [];

  for (let i = 1; i <= args.nWorkflows; i++) {
    const workflowId = randomUUID();
    const t0 = Date.now();
    const r = await runWorkflow(
      workflowId,
      args.nHops,
      args.mode,
      args.failRate,
      args.ttlMs,
      i,
      args.thinkDelayRange,
    );
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const successHops = r.hops.filter((h) => h.outcome === "success").length;
    const status = r.e2e_success ? "success" : "failure";
    const firstFail = r.hops.find((h) => h.outcome === "failure");
    const failTag = firstFail ? `  [${firstFail.failure_step}: ${firstFail.failure_reason}]` : "";
    console.log(
      `[${i}/${args.nWorkflows}] ${workflowId.slice(0, 8)} -> ${status} (${successHops}/${args.nHops} hops, ${dt}s)${failTag}`,
    );
    results.push(r);

    if (i < args.nWorkflows) await sleep(500);
  }

  const ended_at = new Date().toISOString();
  const durationMs = Date.now() - startMs;
  const successCount = results.filter((r) => r.e2e_success).length;
  const successRate = args.nWorkflows ? successCount / args.nWorkflows : 0;
  const sumPaidOnchain = results.reduce(
    (acc, r) => acc + parseFloat(r.usdc_paid_onchain),
    0,
  );
  const sumPaidSucceeded = results.reduce(
    (acc, r) => acc + parseFloat(r.usdc_paid_succeeded),
    0,
  );
  const sumWasted = sumPaidOnchain - sumPaidSucceeded;
  const allTxHashes = results.flatMap((r) =>
    r.hops.map((h) => h.tx_hash).filter((h): h is string => !!h),
  );

  const manifestName = `manifest-${started_at.replace(/[:.]/g, "-")}.json`;
  const manifestPath = path.join(runsDir, manifestName);
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        git_sha: gitSha(),
        mode: args.mode,
        n_workflows: args.nWorkflows,
        n_hops: args.nHops,
        fail_rate: args.failRate,
        ttl_ms: args.ttlMs ?? null,
        think_delay_range_ms: args.thinkDelayRange,
        started_at,
        ended_at,
        duration_ms: durationMs,
        summary: {
          e2e_success_count: successCount,
          e2e_success_rate: successRate,
          usdc_paid_onchain: sumPaidOnchain.toFixed(6),
          usdc_paid_succeeded: sumPaidSucceeded.toFixed(6),
          wasted_usdc: sumWasted.toFixed(6),
        },
        all_tx_hashes: allTxHashes,
      },
      null,
      2,
    ),
  );

  console.log("\n=== Summary ===");
  console.log(`Mode               : ${args.mode}`);
  console.log(`Workflows          : ${args.nWorkflows}`);
  console.log(
    `E2E success        : ${successCount}/${args.nWorkflows} (${(successRate * 100).toFixed(1)}%)`,
  );
  console.log(`USDC paid on-chain : ${sumPaidOnchain.toFixed(6)}`);
  console.log(`USDC succeeded     : ${sumPaidSucceeded.toFixed(6)}`);
  console.log(`USDC wasted        : ${sumWasted.toFixed(6)}`);
  console.log(`Duration           : ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`Manifest           : ${manifestPath}`);
}

main().catch((e) => {
  console.error("\nRun failed:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
