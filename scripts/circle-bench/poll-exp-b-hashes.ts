/**
 * poll-exp-b-hashes.ts — enrich the Exp B run JSON with on-chain Arc
 * Testnet tx hashes for every successful Helix tx (and any Bare tx that
 * happened to land an id).
 *
 * Run:
 *   npx tsx --env-file=.env poll-exp-b-hashes.ts \
 *     experiment-results/exp-b-rate-limit-<ts>.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const TERMINAL_OK = new Set(["COMPLETE", "CONFIRMED"]);
const TERMINAL_BAD = new Set(["FAILED", "DENIED", "CANCELLED"]);
const POLL_MS = 1000;
const POLL_TIMEOUT_MS = 60_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

const apiKey = requireEnv("CIRCLE_API_KEY");
const entitySecret = requireEnv("CIRCLE_ENTITY_SECRET");
const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PollOutcome {
  tx_id: string;
  state: string;
  tx_hash?: string;
  block_hash?: string;
  error_reason?: string;
}

async function pollOne(txId: string): Promise<PollOutcome> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: any = null;
  while (Date.now() < deadline) {
    const r = await client.getTransaction({ id: txId });
    const t = r.data?.transaction;
    last = t;
    const state = t?.state ?? "UNKNOWN";
    if (TERMINAL_OK.has(state) || TERMINAL_BAD.has(state)) {
      return {
        tx_id: txId,
        state,
        tx_hash: t?.txHash,
        block_hash: t?.blockHash,
        error_reason: t?.errorReason,
      };
    }
    await sleep(POLL_MS);
  }
  return { tx_id: txId, state: last?.state ?? "TIMEOUT", error_reason: "polling-timeout" };
}

async function main() {
  const manifestArg = process.argv[2];
  if (!manifestArg) {
    console.error("usage: tsx poll-exp-b-hashes.ts <path-to-exp-b-json>");
    process.exit(1);
  }
  const manifestPath = path.resolve(process.cwd(), manifestArg);
  const data = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  console.log(`\nEnriching ${manifestPath} with on-chain tx hashes...\n`);

  const enrichedRounds: any[] = [];
  for (const round of data.rounds) {
    const enrichedResults = [...round.results];
    const toPoll = round.results
      .map((r: any, idx: number) => ({ idx, r }))
      .filter(({ r }: any) => r.success && r.txId);

    if (toPoll.length === 0) {
      enrichedRounds.push(round);
      continue;
    }

    console.log(`── ${round.mode} arm: polling ${toPoll.length} successful tx ids ──`);
    for (const { idx, r } of toPoll) {
      const outcome = await pollOne(r.txId);
      enrichedResults[idx] = {
        ...r,
        on_chain: {
          state: outcome.state,
          tx_hash: outcome.tx_hash ?? null,
          block_hash: outcome.block_hash ?? null,
          error_reason: outcome.error_reason ?? null,
        },
      };
      const status =
        outcome.state === "COMPLETE" || outcome.state === "CONFIRMED" ? "✓" : "?";
      console.log(
        `  ${status} tx ${String(r.index).padStart(2)}  circle_id=${r.txId.slice(0, 8)}…  state=${outcome.state}  tx_hash=${outcome.tx_hash ?? "(none)"}`,
      );
    }
    enrichedRounds.push({ ...round, results: enrichedResults });
  }

  const out = { ...data, rounds: enrichedRounds, polled_at: new Date().toISOString() };
  fs.writeFileSync(manifestPath, JSON.stringify(out, null, 2));
  console.log(`\n✓ Rewrote ${manifestPath} with on-chain enrichment.`);

  // Print all helix tx hashes for the deck
  const helix = enrichedRounds.find((r) => r.mode === "helix");
  if (helix) {
    console.log(`\nHelix arm — ${helix.results.filter((r: any) => r.on_chain?.tx_hash).length} on-chain Arc Testnet tx hashes:`);
    console.log("─".repeat(80));
    for (const r of helix.results) {
      if (r.on_chain?.tx_hash) {
        console.log(`  tx ${String(r.index).padStart(2)}  ${r.on_chain.tx_hash}`);
        console.log(`           https://testnet.arcscan.app/tx/${r.on_chain.tx_hash}`);
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
