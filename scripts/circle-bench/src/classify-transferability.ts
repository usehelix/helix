/**
 * Failure transferability classifier — feature-based heuristic.
 *
 * Reads the shared Gene Map's repair_audit table, labels each capsule:
 *   chain-agnostic / chain-specific / uncertain
 *
 * This is NOT a learned judgment — it's transparent rule-based classification.
 * Every label carries an auditable reason. "uncertain" is a valid output;
 * rules are NOT tuned to force a label.
 *
 * Output: output/transferability-classification.txt
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(PROJECT_ROOT, "output/transfer-shared.db");
const OUTPUT_PATH = path.join(
  PROJECT_ROOT,
  "output/transferability-classification.txt",
);

// ── Rule sets (transparent heuristics) ─────────────────────────
// Each rule = { pattern, signal }. Order within a category doesn't matter for
// classification — first match wins, signal is reported in the reason.

const CHAIN_SPECIFIC_RULES: { pattern: RegExp; signal: string }[] = [
  { pattern: /\bgasPrice\b/i, signal: "gasPrice mention" },
  { pattern: /\bgasLimit\b/i, signal: "gasLimit mention" },
  { pattern: /\bgas[\s-]?estim/i, signal: "gas-estimation reference" },
  { pattern: /\bgas\b/i, signal: "gas mention" },
  { pattern: /\bblockNumber\b/i, signal: "block-number reference" },
  { pattern: /\bblock\s+confirmation/i, signal: "block-confirmation reference" },
  { pattern: /\bRPC\b/i, signal: "RPC mention" },
  { pattern: /\bendpoint\b/i, signal: "endpoint reference" },
  { pattern: /\bchainId\b/i, signal: "chainId reference" },
  { pattern: /\bnonce\s+too\s+low\b/i, signal: "'nonce too low'" },
];

const CHAIN_AGNOSTIC_RULES: { pattern: RegExp; signal: string }[] = [
  { pattern: /\bstale_quote\b/i, signal: "stale_quote — authorization-window expiry" },
  { pattern: /quote.*\b(expir|TTL)\b/i, signal: "quote TTL / expiry" },
  { pattern: /\btimeout\b.*\b(reason|think)\b/i, signal: "timeout during reasoning/think" },
  { pattern: /\brate[\s-]?limit/i, signal: "rate limit" },
  { pattern: /\b(auth|token)\b.*\bexpir/i, signal: "auth/token expiry" },
  { pattern: /\bstate\b.*\bbetween\s+steps\b/i, signal: "state-between-steps coupling" },
  { pattern: /\boperation\s+order/i, signal: "operation ordering" },
];

interface AuditRow {
  id: number;
  timestamp: number;
  agent_id: string;
  error_message: string;
  failure_code: string;
  failure_category: string;
  strategy: string;
}

interface Classification {
  label: "chain-agnostic" | "chain-specific" | "uncertain";
  matched_signal: string | null;
  reason: string;
}

function classify(row: AuditRow): Classification {
  // Compose a single searchable text from the audit's free-form fields.
  const text = [row.error_message, row.failure_code, row.failure_category]
    .filter(Boolean)
    .join(" ");

  for (const r of CHAIN_SPECIFIC_RULES) {
    if (r.pattern.test(text)) {
      return {
        label: "chain-specific",
        matched_signal: r.signal,
        reason:
          `Labeled chain-specific: matched signal "${r.signal}". Root cause references ` +
          `chain-level state (gas/RPC/block/nonce) — would NOT transfer to a chain with ` +
          `different gas mechanics or confirmation model.`,
      };
    }
  }
  for (const r of CHAIN_AGNOSTIC_RULES) {
    if (r.pattern.test(text)) {
      return {
        label: "chain-agnostic",
        matched_signal: r.signal,
        reason:
          `Labeled chain-agnostic: matched signal "${r.signal}". Root cause is ` +
          `agent-behavior-dependent (quote TTL / ordering / auth-window timing) — ` +
          `independent of any chain's gas or confirmation mechanics.`,
      };
    }
  }
  return {
    label: "uncertain",
    matched_signal: null,
    reason:
      `Labeled uncertain: no rule pattern matched on failure_code="${row.failure_code}", ` +
      `failure_category="${row.failure_category}", error_message="${(row.error_message || "").slice(0, 120)}". ` +
      `Honest abstention — no chain affiliation can be reliably inferred from these features.`,
  };
}

const lines: string[] = [];
lines.push(
  `Failure Transferability Classification — ${new Date().toISOString()}`,
);
lines.push("=".repeat(76));
lines.push("");
lines.push("Method: feature-based heuristic — NOT a learned judgment.");
lines.push(`Source: shared Gene Map at ${path.relative(PROJECT_ROOT, DB_PATH)}, repair_audit table.`);
lines.push("Labels: chain-agnostic / chain-specific / uncertain.");
lines.push("Every label carries an auditable reason. 'uncertain' is a valid output.");
lines.push("Rules are NOT tuned to produce a desired label distribution.");
lines.push("");

let rows: AuditRow[] = [];
let dbError: string | null = null;
try {
  if (!fs.existsSync(DB_PATH)) {
    dbError = `Gene Map file does not exist at ${DB_PATH}.`;
  } else {
    const db = new Database(DB_PATH, { readonly: true });
    rows = db
      .prepare(
        `SELECT id, timestamp, agent_id, error_message, failure_code, failure_category, strategy
         FROM repair_audit ORDER BY timestamp ASC`,
      )
      .all() as AuditRow[];
    db.close();
  }
} catch (e) {
  dbError = `Error reading Gene Map: ${e instanceof Error ? e.message : String(e)}`;
}

if (dbError) {
  lines.push(`ERROR: ${dbError}`);
  lines.push("");
  lines.push("STATUS: INCOMPLETE");
  fs.writeFileSync(OUTPUT_PATH, lines.join("\n"));
  console.error(dbError);
  process.exit(2);
}

const counts = { "chain-agnostic": 0, "chain-specific": 0, uncertain: 0 } as Record<
  Classification["label"],
  number
>;
const classified: (AuditRow & Classification)[] = [];

for (const row of rows) {
  const c = classify(row);
  counts[c.label]++;
  classified.push({ ...row, ...c });
}

lines.push(`Total capsules classified: ${rows.length}`);
lines.push(`  chain-agnostic : ${counts["chain-agnostic"]}`);
lines.push(`  chain-specific : ${counts["chain-specific"]}`);
lines.push(`  uncertain      : ${counts["uncertain"]}`);

if (rows.length === 0) {
  lines.push("");
  lines.push("(No audit entries in repair_audit — Gene Map may be empty.)");
  lines.push("STATUS: complete (empty)");
  fs.writeFileSync(OUTPUT_PATH, lines.join("\n"));
  console.log(`wrote ${OUTPUT_PATH} (empty Gene Map)`);
  process.exit(0);
}

lines.push("");
lines.push("Per-capsule classifications:");
lines.push("-".repeat(76));
for (const c of classified) {
  lines.push("");
  lines.push(`capsule_id=${c.id}   agent=${c.agent_id}   ts=${new Date(c.timestamp).toISOString()}`);
  lines.push(`  label  : ${c.label}`);
  if (c.matched_signal) lines.push(`  signal : ${c.matched_signal}`);
  lines.push(`  reason : ${c.reason}`);
  lines.push(
    `  source : failure_code="${c.failure_code}" failure_category="${c.failure_category}"`,
  );
  lines.push(`           error_message: ${(c.error_message || "").slice(0, 250)}`);
}

lines.push("");
lines.push("STATUS: complete");

fs.writeFileSync(OUTPUT_PATH, lines.join("\n"));
console.log(`wrote ${OUTPUT_PATH} — ${rows.length} capsules classified`);
