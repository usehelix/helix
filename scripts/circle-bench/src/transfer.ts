import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHelixHopRunner } from "./helix-wrap";
import { thinkDelayFor, shouldInject503, type HopResult, type HopSeeds } from "./workflow";
import type { ChainConfig } from "./chain-config";

export type TransferMode = "shared" | "isolated";

export interface TransferRunOptions {
  mode: TransferMode;
  nAgents: number;
  nHops: number;
  ttlMs?: number;
  thinkDelayRange: [number, number];
  failRate: number;
  chain: ChainConfig;
}

export interface AgentResult {
  agent_index: number;
  transfer_mode: TransferMode;
  chain: string;
  gene_map_path: string;
  e2e_success: boolean;
  hops: HopResult[];
  failures: {
    hop_index: number;
    failure_step?: string;
    failure_reason?: string;
  }[];
  /** How many audit entries existed when this agent began. */
  gene_map_size_at_start: number;
  /** How many hops in this agent's workflow had preflight fire (= late_discover). */
  preflight_hits: number;
  /** UUID for the workflow this agent ran. */
  workflow_id: string;
  duration_ms: number;
  started_at: string;
  ended_at: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "output");
const runsDir = path.join(projectRoot, "runs");

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function geneMapPathFor(mode: TransferMode, agentIndex: number): string {
  if (mode === "shared") return path.join(outputDir, "transfer-shared.db");
  return path.join(outputDir, `transfer-isolated-${agentIndex}.db`);
}

function clearStaleGeneMaps(mode: TransferMode, nAgents: number): void {
  if (mode === "shared") {
    const p = geneMapPathFor("shared", 1);
    if (existsSync(p)) rmSync(p);
  } else {
    for (let i = 1; i <= nAgents; i++) {
      const p = geneMapPathFor("isolated", i);
      if (existsSync(p)) rmSync(p);
    }
  }
}

export async function runTransferExperiment(opts: TransferRunOptions): Promise<void> {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const perModeDir = path.join(runsDir, `transfer-${opts.mode}`);
  if (!existsSync(perModeDir)) mkdirSync(perModeDir, { recursive: true });

  // Cold-start guarantee: clear any pre-existing Gene Map files for this mode.
  clearStaleGeneMaps(opts.mode, opts.nAgents);

  const started_at = new Date().toISOString();
  const runStartMs = Date.now();
  const agents: AgentResult[] = [];

  console.log(
    `transfer experiment: mode=${opts.mode} chain=${opts.chain.name} ` +
      `n-agents=${opts.nAgents} n-hops=${opts.nHops} ttl-ms=${opts.ttlMs} ` +
      `think-delay=[${opts.thinkDelayRange[0]},${opts.thinkDelayRange[1]}]ms ` +
      `fail-rate=${opts.failRate}`,
  );

  for (let agentIdx = 1; agentIdx <= opts.nAgents; agentIdx++) {
    const dbPath = geneMapPathFor(opts.mode, agentIdx);
    const agentId = `transfer-${opts.mode}-${agentIdx}`;
    const runner = createHelixHopRunner({ geneMapPath: dbPath, agentId });

    const sizeAtStart = runner.getAuditCount();
    const workflowId = randomUUID();
    const agentStartedAt = new Date().toISOString();
    const agentStartMs = Date.now();
    const hops: HopResult[] = [];
    let preflightHits = 0;

    for (let h = 0; h < opts.nHops; h++) {
      const seeds: HopSeeds = {
        thinkDelayMs: thinkDelayFor(agentIdx, h, opts.thinkDelayRange),
        inject503: shouldInject503(agentIdx, h, opts.failRate),
      };
      const hop = await runner.runHop(h, workflowId, opts.ttlMs, seeds);
      hops.push(hop);
      if (hop.preflight_applied) preflightHits++;
      if (hop.outcome === "failure") break;
    }

    const e2eSuccess =
      hops.length === opts.nHops && hops.every((h) => h.outcome === "success");
    const failures = hops
      .filter((h) => h.outcome === "failure")
      .map((h) => ({
        hop_index: h.hop_index,
        failure_step: h.failure_step,
        failure_reason: h.failure_reason,
      }));

    const agentResult: AgentResult = {
      agent_index: agentIdx,
      transfer_mode: opts.mode,
      chain: opts.chain.key,
      gene_map_path: path.relative(projectRoot, dbPath),
      e2e_success: e2eSuccess,
      hops,
      failures,
      gene_map_size_at_start: sizeAtStart,
      preflight_hits: preflightHits,
      workflow_id: workflowId,
      duration_ms: Date.now() - agentStartMs,
      started_at: agentStartedAt,
      ended_at: new Date().toISOString(),
    };

    writeFileSync(
      path.join(perModeDir, `agent-${agentIdx}.json`),
      JSON.stringify(agentResult, null, 2),
    );
    agents.push(agentResult);

    runner.close();

    const dt = (agentResult.duration_ms / 1000).toFixed(1);
    const status = e2eSuccess ? "success" : "failure";
    const firstFail = failures[0];
    const failTag = firstFail
      ? `  [${firstFail.failure_step}: ${firstFail.failure_reason}]`
      : "";
    console.log(
      `[${agentIdx}/${opts.nAgents}] agent=${agentIdx} ` +
        `size_at_start=${sizeAtStart} preflight_hits=${preflightHits} ` +
        `e2e=${status} (${hops.filter((h) => h.outcome === "success").length}/${opts.nHops} hops, ${dt}s)${failTag}`,
    );
  }

  // Manifest
  const ended_at = new Date().toISOString();
  const durationMs = Date.now() - runStartMs;
  const successCount = agents.filter((a) => a.e2e_success).length;
  const ts = started_at.replace(/[:.]/g, "-");
  const manifestPath = path.join(runsDir, `transfer-${opts.mode}-manifest-${ts}.json`);

  const allTxHashes = agents.flatMap((a) =>
    a.hops.map((h) => h.tx_hash).filter((h): h is string => !!h),
  );

  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        experiment: "transfer",
        git_sha: gitSha(),
        mode: opts.mode,
        chain: opts.chain.key,
        n_agents: opts.nAgents,
        n_hops: opts.nHops,
        ttl_ms: opts.ttlMs ?? null,
        think_delay_range_ms: opts.thinkDelayRange,
        fail_rate: opts.failRate,
        started_at,
        ended_at,
        duration_ms: durationMs,
        summary: {
          success_count: successCount,
          success_rate: opts.nAgents ? successCount / opts.nAgents : 0,
        },
        sequence: agents.map((a) => ({
          agent_index: a.agent_index,
          gene_map_size_at_start: a.gene_map_size_at_start,
          preflight_hits: a.preflight_hits,
          e2e_success: a.e2e_success,
          first_failure_step: a.failures[0]?.failure_step ?? null,
          first_failure_reason: a.failures[0]?.failure_reason ?? null,
        })),
        all_tx_hashes: allTxHashes,
      },
      null,
      2,
    ),
  );

  console.log("\n=== Transfer Summary ===");
  console.log(`Mode             : ${opts.mode}`);
  console.log(`Chain            : ${opts.chain.name}`);
  console.log(`Agents           : ${opts.nAgents}`);
  console.log(
    `E2E success      : ${successCount}/${opts.nAgents} (${((successCount / opts.nAgents) * 100).toFixed(1)}%)`,
  );
  console.log(`Total tx hashes  : ${allTxHashes.length}`);
  console.log(`Duration         : ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`Manifest         : ${manifestPath}`);
}
