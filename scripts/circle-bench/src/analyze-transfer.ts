/**
 * Analyze the transfer experiment runs.
 *
 * Reads runs/transfer-shared/agent-*.json and runs/transfer-isolated/agent-*.json,
 * produces per-agent sequences, cumulative success, cold-start position,
 * post-cold-start success rate. Infrastructure failures are bucketed
 * separately and excluded from experimental denominators.
 *
 * Output: output/transfer-summary.txt
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(PROJECT_ROOT, "runs");
const OUTPUT_PATH = path.join(PROJECT_ROOT, "output/transfer-summary.txt");

const EXPECTED_N = 50;
const MODES = ["shared", "isolated"] as const;
type Mode = (typeof MODES)[number];

interface AgentFile {
  agent_index: number;
  e2e_success: boolean;
  gene_map_size_at_start: number;
  preflight_hits: number;
  failures: { failure_step?: string; failure_reason?: string }[];
}

type FailKind = "stale_quote" | "503" | "infrastructure" | "other" | "n/a";

function classifyFailure(reason?: string): FailKind {
  if (!reason) return "n/a";
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|ENOTFOUND/i.test(reason)) {
    return "infrastructure";
  }
  if (/stale_quote/.test(reason)) return "stale_quote";
  if (/503/.test(reason)) return "503";
  return "other";
}

function loadAgents(mode: Mode): AgentFile[] {
  const dir = path.join(RUNS_DIR, `transfer-${mode}`);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /^agent-\d+\.json$/.test(f));
  const agents: AgentFile[] = [];
  for (const f of files) {
    try {
      agents.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    } catch {}
  }
  agents.sort((a, b) => a.agent_index - b.agent_index);
  return agents;
}

function analyzeMode(mode: Mode, expectedN: number) {
  const agents = loadAgents(mode);
  const indicesPresent = new Set(agents.map((a) => a.agent_index));
  const missing: number[] = [];
  for (let i = 1; i <= expectedN; i++) if (!indicesPresent.has(i)) missing.push(i);

  let success = 0,
    stale = 0,
    c503 = 0,
    infra = 0,
    other = 0;
  const infraDetails: { agent_index: number; reason: string }[] = [];

  for (const a of agents) {
    if (a.e2e_success) {
      success++;
      continue;
    }
    const reason = a.failures?.[0]?.failure_reason;
    const kind = classifyFailure(reason);
    if (kind === "infrastructure") {
      infra++;
      infraDetails.push({ agent_index: a.agent_index, reason: reason ?? "" });
    } else if (kind === "stale_quote") stale++;
    else if (kind === "503") c503++;
    else other++;
  }

  // Cold-start position: first agent that failed stale_quote with size_at_start=0
  let coldStart: number | null = null;
  for (const a of agents) {
    if (a.e2e_success) continue;
    const reason = a.failures?.[0]?.failure_reason;
    if (
      classifyFailure(reason) === "stale_quote" &&
      a.gene_map_size_at_start === 0
    ) {
      coldStart = a.agent_index;
      break;
    }
  }

  // Post-cold-start success rate (excluding infrastructure)
  const postAll = coldStart != null
    ? agents.filter((a) => a.agent_index > coldStart!)
    : agents;
  const postValid = postAll.filter(
    (a) => classifyFailure(a.failures?.[0]?.failure_reason) !== "infrastructure",
  );
  const postSuccess = postValid.filter((a) => a.e2e_success).length;
  const postRate = postValid.length ? postSuccess / postValid.length : null;

  // Cumulative success (count up to and including this agent)
  const cumulative: { idx: number; success_count: number }[] = [];
  let cum = 0;
  for (const a of agents) {
    if (a.e2e_success) cum++;
    cumulative.push({ idx: a.agent_index, success_count: cum });
  }

  return {
    mode,
    expectedN,
    agents,
    missing,
    success,
    stale,
    c503,
    infra,
    infraDetails,
    other,
    coldStart,
    postValid: postValid.length,
    postSuccess,
    postRate,
    cumulative,
  };
}

const lines: string[] = [];
const ts = new Date().toISOString();
lines.push(`Transfer Experiment Analysis — ${ts}`);
lines.push("=".repeat(76));

let incomplete = false;
const results = Object.fromEntries(
  MODES.map((m) => [m, analyzeMode(m, EXPECTED_N)]),
) as Record<Mode, ReturnType<typeof analyzeMode>>;

for (const m of MODES) {
  const r = results[m];
  lines.push("");
  lines.push(`Mode: ${m}   (expected n=${EXPECTED_N}, found n=${r.agents.length})`);
  lines.push("-".repeat(76));
  if (r.missing.length > 0) {
    incomplete = true;
    lines.push(`  ⚠ INCOMPLETE: missing agent indices: ${r.missing.join(", ")}`);
  }
  lines.push(
    `  e2e_success           : ${r.success}/${r.agents.length} (${
      r.agents.length ? ((r.success / r.agents.length) * 100).toFixed(1) : "n/a"
    }%)`,
  );
  lines.push(`  stale_quote (exp)     : ${r.stale}`);
  lines.push(`  503 (exp)             : ${r.c503}`);
  lines.push(`  infrastructure (excl) : ${r.infra}`);
  if (r.infra > 0) {
    for (const d of r.infraDetails) {
      lines.push(`    - agent #${d.agent_index}: ${d.reason}`);
    }
  }
  lines.push(`  other failures        : ${r.other}`);
  if (r.coldStart != null) {
    lines.push(`  cold-start failure at : agent #${r.coldStart}`);
    if (r.postValid > 0) {
      lines.push(
        `  post-cold-start       : ${r.postSuccess}/${r.postValid} (${
          ((r.postRate ?? 0) * 100).toFixed(1)
        }%) — excludes infrastructure failures`,
      );
    }
  } else if (m === "shared") {
    lines.push(`  cold-start failure    : none detected (unexpected for shared)`);
  } else {
    lines.push(
      `  cold-start failure    : every agent is independently cold (expected for isolated)`,
    );
  }
}

// Side-by-side delta
lines.push("");
lines.push("Delta: helix-shared − helix-isolated");
lines.push("-".repeat(76));
const s = results["shared"];
const i = results["isolated"];
const sRate = s.agents.length ? (s.success / s.agents.length) * 100 : 0;
const iRate = i.agents.length ? (i.success / i.agents.length) * 100 : 0;
lines.push(
  `  E2E success  shared ${sRate.toFixed(1)}%  vs  isolated ${iRate.toFixed(1)}%   Δ ${
    sRate - iRate >= 0 ? "+" : ""
  }${(sRate - iRate).toFixed(1)}pp`,
);

// Per-agent sequences
for (const m of MODES) {
  const r = results[m];
  lines.push("");
  lines.push(`Per-agent sequence (${m}):`);
  lines.push("-".repeat(76));
  lines.push(" idx | size_at_start | preflight_hits | e2e | first failure");
  for (const a of r.agents) {
    const failReason = a.failures?.[0]?.failure_reason ?? "";
    const status = a.e2e_success ? "✓" : "✗";
    lines.push(
      `  ${String(a.agent_index).padStart(2)} | ${String(a.gene_map_size_at_start).padStart(13)} | ${String(
        a.preflight_hits,
      ).padStart(14)} | ${status}   | ${failReason.slice(0, 60)}`,
    );
  }
}

if (incomplete) {
  lines.push("");
  lines.push("STATUS: INCOMPLETE — see missing agents above.");
} else {
  lines.push("");
  lines.push("STATUS: complete");
}

fs.writeFileSync(OUTPUT_PATH, lines.join("\n"));
console.log(`wrote ${OUTPUT_PATH}`);
if (incomplete) process.exit(2);
