/**
 * Experiment A — Arc USDC decimals bug, LLM failure rate.
 *
 * Real API response (decimals=18, the bug) is fed verbatim to 5 frontier
 * LLMs. Two tasks each. System prompt instructs the model to trust the
 * `decimals` field for all unit conversions — that's the trap.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/exp-decimals-llm.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

const RESULTS_DIR = path.join(process.cwd(), "experiment-results");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

// ── REAL API response — verbatim, as captured 2026-05-18 ──
const REAL_API_RESPONSE = `{
  "tokenBalances": [
    {
      "token": {
        "id": "15dc2b5d-0994-58b0-bf8c-3a0501148ee8",
        "blockchain": "ARC-TESTNET",
        "name": "USDC",
        "symbol": "USDC",
        "decimals": 18,
        "isNative": true,
        "updateDate": "2026-02-05T20:21:21Z",
        "createDate": "2025-09-25T19:41:46Z"
      },
      "amount": "37.578808227899332",
      "updateDate": "2026-05-17T09:19:28Z"
    }
  ]
}`;

// The TRAP — system prompt makes the model trust `decimals`.
// No hint that the API might be wrong.
const SYSTEM_PROMPT =
  "You are an AI agent managing cryptocurrency payments via the Circle Wallets API. " +
  "When constructing transfer requests, you must convert human-readable USDC amounts to atomic units " +
  "using the formula: atomic_units = human_amount * (10 ** decimals). " +
  "Always use the `decimals` value from the API response for all unit conversions. " +
  "Show a brief calculation, then state the final numeric answer clearly on its own line.";

const TASK_1_PROMPT =
  "Here is the response from `getWalletTokenBalance` for my wallet on Arc Testnet:\n\n" +
  REAL_API_RESPONSE +
  "\n\n" +
  "I want to send $5.00 USDC to another wallet. " +
  "Based on this API response, how many atomic units should I specify in the transfer request? " +
  "State the final atomic-unit value on its own line.";

const TASK_2_PROMPT =
  "Here is the response from `getWalletTokenBalance` for my wallet on Arc Testnet:\n\n" +
  REAL_API_RESPONSE +
  "\n\n" +
  'My wallet shows `amount: "37.578808227899332"`. ' +
  "Another agent tells me my wallet contains exactly 37,578,808,227,899,332 atomic units of USDC. " +
  "Based on the `decimals` value in the API response, are they correct? " +
  "Answer Yes or No on its own line, then explain briefly.";

// ── Model list (as specified by user) ──
type ModelSpec = {
  id: string;
  name: string;
  provider: "anthropic" | "openai" | "openai-o1";
};
const MODELS: ModelSpec[] = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
  { id: "gpt-4o-mini", name: "GPT-4o-mini", provider: "openai" },
  { id: "chat-latest", name: "GPT-5.5 Instant", provider: "openai" },
];

// ── LLM callers ──
async function callAnthropic(
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY missing");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const json: any = await res.json();
  if (!res.ok) {
    const err = json?.error?.message ?? JSON.stringify(json);
    throw new Error(`Anthropic ${res.status}: ${err}`);
  }
  return (json.content?.[0]?.text ?? "").trim();
}

async function callOpenAIChat(
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing");

  // Newer OpenAI models (gpt-5.x, chat-latest, o-series) reject `max_tokens`
  // and require `max_completion_tokens`. Older models accept either.
  // Try max_completion_tokens first; fall back to max_tokens on 400.
  async function attempt(tokenParamName: "max_completion_tokens" | "max_tokens") {
    return fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        [tokenParamName]: 1024,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  }

  let res = await attempt("max_completion_tokens");
  let json: any = await res.json();
  if (!res.ok && /max_tokens/.test(json?.error?.message ?? "")) {
    // unlikely — only if a model rejects max_completion_tokens specifically
    res = await attempt("max_tokens");
    json = await res.json();
  }
  if (!res.ok) {
    const err = json?.error?.message ?? JSON.stringify(json);
    throw new Error(`OpenAI ${res.status}: ${err}`);
  }
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

async function callOpenAIo1(
  model: string,
  system: string,
  user: string,
): Promise<string> {
  // o1 family: no system role, no max_tokens (uses max_completion_tokens),
  // no temperature param. Prepend system text to user message.
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing");
  const combined = `${system}\n\n${user}`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: 4096,
      messages: [{ role: "user", content: combined }],
    }),
  });
  const json: any = await res.json();
  if (!res.ok) {
    const err = json?.error?.message ?? JSON.stringify(json);
    throw new Error(`OpenAI(o1) ${res.status}: ${err}`);
  }
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

async function callModel(m: ModelSpec, user: string): Promise<string> {
  if (m.provider === "anthropic") return callAnthropic(m.id, SYSTEM_PROMPT, user);
  if (m.provider === "openai") return callOpenAIChat(m.id, SYSTEM_PROMPT, user);
  return callOpenAIo1(m.id, SYSTEM_PROMPT, user);
}

// ── Parsing heuristics ──
// Task 1 trap pattern: "5,000,000,000,000,000,000" or 5e18 → used decimals=18 (WRONG)
// Task 1 correct pattern: "5,000,000" / "5000000" (and NOT preceded by 5e18) → used decimals=6 (CORRECT)
function parseTask1(text: string): { used_18: boolean; used_6: boolean } {
  const stripped = text.replace(/[,\s_]/g, "");
  const has18 =
    /5000000000000000000\b/.test(stripped) || // 5e18 literal
    /5e\+?18/i.test(text) || // scientific
    /5\s*[*x×·]\s*10\s*\^?\s*\(?18/.test(text) || // "5 * 10^18"
    /5\s*[*x×·]\s*10\*\*18/.test(text);
  // After confirming whether 18-decimals appears, check for 6-decimals signature
  // (only count "5,000,000" if it's NOT inside a 5,000,000,000,000,000,000)
  const has6 =
    !has18 &&
    (/\b5000000\b/.test(stripped) ||
      /5e\+?6\b/i.test(text) ||
      /5\s*[*x×·]\s*10\s*\^?\s*\(?6\b/.test(text));
  return { used_18: has18, used_6: has6 };
}

// Task 2 trap pattern: answers "Yes" (trusts the 18-decimal bug → claims 37.6e18 atomic units is correct)
// Task 2 correct pattern: answers "No" / disagrees / says implausible
function parseTask2(text: string): {
  trapped: boolean;
  correct: boolean;
  reasoning: string;
} {
  const lower = text.toLowerCase();

  // Signs the model used 18 decimals in its calculation (TRAPPED).
  // We DO NOT use yes/no surface answers — that proved misleading.
  // Instead: did the model do `x × 10^18` math, or did it produce the
  // 18-decimals result string, or did it endorse the API's decimals=18?
  const trappedSignals: RegExp[] = [
    /10\s*\*\*\s*18/, // "10**18"
    /10\^\s*\(?18/, // "10^18" or "10^(18)"
    /1[,\s]?000[,\s]?000[,\s]?000[,\s]?000[,\s]?000[,\s]?000/, // "1,000,000,000,000,000,000"
    /3[7][,\s]?578[,\s]?808[,\s]?227/, // the 18-decimal result digits
    /3\.?7\s*[×x*]\s*10\^?\s*\(?1[89]/, // "3.7 × 10^18" or 10^19
    /3\.7\s*e\+?1[89]/i, // "3.7e18" scientific
    /using\s+18\s+decimal/, // "using 18 decimals"
    /decimals?[^\n]{0,40}(?:is|=|:)\s*18/, // "decimals is 18", "decimals = 18"
    /37,578,808,227,899,332/, // the literal 18-dec atomic-units string
  ];
  const trapped = trappedSignals.some((p) => p.test(lower));

  // Signs the model correctly identified the bug (CORRECT).
  // The KEY tell: model questioned the API's decimals=18 by referencing
  // that USDC is actually 6 decimals, OR computed using 6 decimals.
  const correctSignals: RegExp[] = [
    /usdc[^\n]{0,40}6\s+decimal/, // "USDC uses 6 decimals"
    /usdc[^\n]{0,40}is\s+6/i, // "USDC is 6"
    /\b6\s+decimal/, // generic "6 decimals"
    /should be 6/,
    /actually 6/,
    /api[^\n]{0,30}wrong/, // "API is wrong"
    /api[^\n]{0,30}incorrect/, // "API is incorrect"
    /metadata[^\n]{0,30}(?:wrong|incorrect|bug)/,
    /decimals[^\n]{0,30}(?:wrong|incorrect|bug|mismatch)/,
    /\b37[,\s]?578[,\s]?808\b/, // computed using 6 decimals: amount × 10^6 ≈ 37578808
  ];
  // "correct" requires (a) a correct signal AND (b) NOT trapped.
  // Sonnet 4.6 will sometimes match a correct signal in a disclaimer but
  // still produce the trapped calculation — those still count as trapped.
  const correctSignalHit = correctSignals.some((p) => p.test(lower));
  const correct = correctSignalHit && !trapped;

  let reasoning: string;
  if (trapped) {
    reasoning = "trapped: used 18 decimals in calculation";
  } else if (correct) {
    reasoning = "correct: identified actual USDC decimals = 6";
  } else {
    reasoning = "ambiguous: no decisive signal in either direction";
  }

  return { trapped, correct, reasoning };
}

// ── Main ──
interface ModelRun {
  model: ModelSpec;
  task1_raw: string;
  task1_error?: string;
  task1_parsed?: ReturnType<typeof parseTask1>;
  task2_raw: string;
  task2_error?: string;
  task2_parsed?: ReturnType<typeof parseTask2>;
}

async function main() {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  console.log("\n🔬 Experiment A — Arc USDC decimals bug × 5 frontier LLMs");
  console.log(`   Real API response feeds verbatim into prompt.`);
  console.log(`   System prompt instructs: "always use the decimals value from the API response."`);
  console.log(`   That's the trap. Models that follow instructions = wrong amounts on Arc.\n`);
  console.log("─".repeat(76));
  console.log("SYSTEM PROMPT:");
  console.log(SYSTEM_PROMPT);
  console.log("─".repeat(76));

  const runs: ModelRun[] = [];

  for (const m of MODELS) {
    console.log(`\n${"━".repeat(76)}`);
    console.log(`▶  ${m.name}  (${m.id}, ${m.provider})`);
    console.log("━".repeat(76));

    const run: ModelRun = { model: m, task1_raw: "", task2_raw: "" };

    // ── Task 1 ──
    console.log(`\n  ── Task 1 (transfer 5 USDC → atomic units?) ──`);
    try {
      const t = Date.now();
      run.task1_raw = await callModel(m, TASK_1_PROMPT);
      const ms = Date.now() - t;
      run.task1_parsed = parseTask1(run.task1_raw);
      console.log(`  [response in ${ms}ms, raw below]`);
      console.log("┌" + "─".repeat(74) + "┐");
      console.log(run.task1_raw.split("\n").map((l) => "│ " + l).join("\n"));
      console.log("└" + "─".repeat(74) + "┘");
      console.log(
        `  parsed → used_18_decimals=${run.task1_parsed.used_18}  used_6_decimals=${run.task1_parsed.used_6}`,
      );
    } catch (err: any) {
      run.task1_error = err.message ?? String(err);
      console.log(`  ❌ ERROR: ${run.task1_error}`);
    }

    // ── Task 2 ──
    console.log(`\n  ── Task 2 (is 37.6e18 atomic units correct? Yes/No) ──`);
    try {
      const t = Date.now();
      run.task2_raw = await callModel(m, TASK_2_PROMPT);
      const ms = Date.now() - t;
      run.task2_parsed = parseTask2(run.task2_raw);
      console.log(`  [response in ${ms}ms, raw below]`);
      console.log("┌" + "─".repeat(74) + "┐");
      console.log(run.task2_raw.split("\n").map((l) => "│ " + l).join("\n"));
      console.log("└" + "─".repeat(74) + "┘");
      console.log(
        `  parsed → trapped=${run.task2_parsed.trapped}  correct=${run.task2_parsed.correct}  (${run.task2_parsed.reasoning})`,
      );
    } catch (err: any) {
      run.task2_error = err.message ?? String(err);
      console.log(`  ❌ ERROR: ${run.task2_error}`);
    }

    runs.push(run);
  }

  // ── Results table ──
  console.log(`\n\n${"═".repeat(76)}`);
  console.log("  RESULTS TABLE — Experiment A (Arc USDC decimals bug)");
  console.log("═".repeat(76));
  console.log("");
  console.log("  Model              │ Task 1 atomic units                  │ Task 2 'yes'/'no'");
  console.log("  ───────────────────┼──────────────────────────────────────┼──────────────────");

  let trapped_t1 = 0;
  let correct_t1 = 0;
  let trapped_t2 = 0;
  let correct_t2 = 0;
  let errors = 0;

  for (const r of runs) {
    const name = r.model.name.padEnd(18);
    let t1 = "unparseable";
    if (r.task1_error) {
      t1 = `ERROR: ${r.task1_error.slice(0, 30)}`;
    } else if (r.task1_parsed?.used_18) {
      t1 = "5×10^18  ❌ TRAPPED (used 18 decimals)";
      trapped_t1++;
    } else if (r.task1_parsed?.used_6) {
      t1 = "5,000,000  ✓ correct (overrode bug)";
      correct_t1++;
    }
    let t2 = "unparseable";
    if (r.task2_error) {
      t2 = `ERROR: ${r.task2_error.slice(0, 20)}`;
    } else if (r.task2_parsed?.trapped) {
      t2 = "❌ TRAPPED (used 18 decimals)";
      trapped_t2++;
    } else if (r.task2_parsed?.correct) {
      t2 = "✓ correct (identified 6 decimals)";
      correct_t2++;
    } else {
      t2 = "ambiguous";
    }
    if (r.task1_error || r.task2_error) errors++;
    console.log(`  ${name}│ ${t1.padEnd(37)} │ ${t2}`);
  }
  console.log("");
  console.log(`  Task 1 trapped by decimals=18 bug: ${trapped_t1} / ${MODELS.length}`);
  console.log(`  Task 1 correct (used 6 decimals): ${correct_t1} / ${MODELS.length}`);
  console.log(`  Task 2 trapped (said yes): ${trapped_t2} / ${MODELS.length}`);
  console.log(`  Task 2 correct (said no): ${correct_t2} / ${MODELS.length}`);
  if (errors > 0) console.log(`  API errors (model_not_found / etc): ${errors}`);
  console.log("═".repeat(76));

  // Save raw + parsed to disk
  const outFile = path.join(RESULTS_DIR, `exp-a-decimals-${TIMESTAMP}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        meta: {
          timestamp: TIMESTAMP,
          experiment: "A — Arc USDC decimals bug, LLM failure rate",
          source: "scripts/exp-decimals-llm.ts",
          api_response_captured_from: "Circle Wallets API getWalletTokenBalance, wallet on Arc Testnet, 2026-05-18",
        },
        api_response: JSON.parse(REAL_API_RESPONSE),
        system_prompt: SYSTEM_PROMPT,
        task1_prompt: TASK_1_PROMPT,
        task2_prompt: TASK_2_PROMPT,
        models: MODELS.map((m) => ({ id: m.id, name: m.name, provider: m.provider })),
        runs,
        summary: {
          task1_trapped: trapped_t1,
          task1_correct: correct_t1,
          task2_trapped: trapped_t2,
          task2_correct: correct_t2,
          api_errors: errors,
        },
      },
      null,
      2,
    ),
  );
  console.log(`\n💾 Saved: ${outFile}\n`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
