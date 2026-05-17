#!/usr/bin/env node
// summary.js — aggregate the 4 N=50 runs into output/overnight-summary.txt
const fs = require("fs");
const path = require("path");

const BENCH_DIR = "/Users/haimo/Projects/helix/scripts/circle-bench";

const RUNS = [
  {
    id: "#1",
    name: "bare  fail=0.05",
    mode: "bare",
    manifestPath: `${BENCH_DIR}/runs/manifest-2026-05-16T08-05-23-553Z.json`,
  },
  {
    id: "#2",
    name: "helix fail=0.05",
    mode: "helix",
    logPath: `${BENCH_DIR}/output/helix-run-005.log`,
  },
  {
    id: "#3",
    name: "bare  fail=0   ",
    mode: "bare",
    logPath: `${BENCH_DIR}/output/bare-run-006.log`,
  },
  {
    id: "#4",
    name: "helix fail=0   ",
    mode: "helix",
    logPath: `${BENCH_DIR}/output/helix-run-007.log`,
  },
];

function manifestPathFromLog(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return null;
  const text = fs.readFileSync(logPath, "utf8");
  const m = text.match(/Manifest\s*:\s*(\S+manifest-\S+\.json)/);
  return m ? m[1].trim() : null;
}

function analyze(manifestPath, mode) {
  if (!manifestPath || !fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  const started = new Date(manifest.started_at).getTime();
  const ended = new Date(manifest.ended_at).getTime();
  const dir = path.dirname(manifestPath);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("manifest"));
  let stale = 0,
    c503 = 0,
    success = 0,
    infra = 0,
    other = 0,
    total = 0;
  const infraDetails = [];
  for (const f of files) {
    try {
      const w = JSON.parse(fs.readFileSync(path.join(dir, f)));
      if (w.mode !== mode) continue;
      const t = new Date(w.started_at).getTime();
      if (t < started || t > ended) continue;
      total++;
      if (w.e2e_success) {
        success++;
        continue;
      }
      const failed = w.hops.find((h) => h.outcome === "failure");
      if (!failed) continue;
      if (failed.injected_503 || /503/.test(failed.failure_reason || "")) {
        c503++;
      } else if (/stale_quote/.test(failed.failure_reason || "")) {
        stale++;
      } else if (
        /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|ENOTFOUND/i.test(
          failed.failure_reason || "",
        )
      ) {
        infra++;
        infraDetails.push({
          workflow_id: w.workflow_id,
          reason: failed.failure_reason,
        });
      } else {
        other++;
      }
    } catch {}
  }
  return { manifest, stale, c503, success, infra, infraDetails, other, total };
}

const lines = [];
lines.push(`Overnight Summary — ${new Date().toISOString()}`);
lines.push("=".repeat(76));

const results = {};
for (const r of RUNS) {
  const mp = r.manifestPath || manifestPathFromLog(r.logPath);
  const a = mp ? analyze(mp, r.mode) : null;
  results[r.id] = a ? { ...a, manifestPath: mp } : null;

  lines.push("");
  lines.push(`${r.id}  ${r.name}`);
  lines.push("-".repeat(76));
  if (!a) {
    lines.push(`  STATUS: INCOMPLETE — no manifest found`);
    if (r.logPath && fs.existsSync(r.logPath)) {
      const sz = fs.statSync(r.logPath).size;
      lines.push(`  Log    : ${r.logPath}  (${sz} bytes)`);
    } else if (r.logPath) {
      lines.push(`  Log    : ${r.logPath}  (does not exist)`);
    }
    continue;
  }
  const m = a.manifest;
  lines.push(
    `  E2E success           : ${m.summary.e2e_success_count}/${m.n_workflows} (${(m.summary.e2e_success_rate * 100).toFixed(1)}%)`,
  );
  if (a.infra > 0) {
    const validTotal = m.n_workflows - a.infra;
    const validRate = (m.summary.e2e_success_count / validTotal) * 100;
    lines.push(
      `  E2E excl infra        : ${m.summary.e2e_success_count}/${validTotal} (${validRate.toFixed(1)}%)`,
    );
  }
  lines.push(`  stale_quote           : ${a.stale}`);
  lines.push(`  503 (seeded)          : ${a.c503}`);
  lines.push(`  infrastructure (excl) : ${a.infra}`);
  if (a.infra > 0) {
    for (const d of a.infraDetails) {
      lines.push(`    - ${d.workflow_id.slice(0, 8)}: ${d.reason}`);
    }
  }
  lines.push(`  other failures        : ${a.other}`);
  lines.push(`  USDC paid             : ${m.summary.usdc_paid_onchain}`);
  lines.push(`  USDC succeeded        : ${m.summary.usdc_paid_succeeded}`);
  lines.push(`  USDC wasted           : ${m.summary.wasted_usdc}`);
  lines.push(`  Duration              : ${(m.duration_ms / 1000).toFixed(1)}s`);
  lines.push(`  Tx hashes             : ${m.all_tx_hashes.length}`);
  lines.push(`  Manifest              : ${mp}`);
}

lines.push("");
lines.push("Deltas (helix − bare)");
lines.push("-".repeat(76));
const pairs = [
  ["#1", "#2", "fail=0.05"],
  ["#3", "#4", "fail=0   "],
];
for (const [bareId, helixId, label] of pairs) {
  const b = results[bareId];
  const h = results[helixId];
  if (!b || !h) {
    lines.push(`  ${label}: pair incomplete`);
    continue;
  }
  // Use infra-excluded rates when applicable so deltas are honest.
  const bValid = b.manifest.n_workflows - b.infra;
  const hValid = h.manifest.n_workflows - h.infra;
  const eB = (b.manifest.summary.e2e_success_count / bValid) * 100;
  const eH = (h.manifest.summary.e2e_success_count / hValid) * 100;
  const infraNote =
    b.infra > 0 || h.infra > 0
      ? `   (excl infra: bare=${b.infra}, helix=${h.infra})`
      : "";
  const deltaE = eH - eB;
  const wasteB = parseFloat(b.manifest.summary.wasted_usdc);
  const wasteH = parseFloat(h.manifest.summary.wasted_usdc);
  lines.push(
    `  ${label}  E2E   ${eB.toFixed(1)}% → ${eH.toFixed(1)}%   Δ ${deltaE >= 0 ? "+" : ""}${deltaE.toFixed(1)}pp${infraNote}`,
  );
  lines.push(
    `  ${label}  USDC wasted ${wasteB.toFixed(4)} → ${wasteH.toFixed(4)}   (saved ${(wasteB - wasteH).toFixed(4)})`,
  );
}

console.log(lines.join("\n"));
