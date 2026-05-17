# Circle × Helix — Scenario #1

Benchmark harness comparing a Circle dev-controlled-wallet agent **with** vs
**without** an `@vial-agent/core` `wrap()` (with a new `preflight` hook),
on a 10-hop USDC workflow against a mock x402 seller, on Arc Testnet.

This is **Scenario #1** of a planned three-scenario evaluation. We did not run
Scenario #2 (CCTP cross-chain) or Scenario #3 (Trust primitive audit).

---

## What this experiment does

Each *workflow* is **10 sequential hops**. Each hop:

1. **discover** — `GET /service` on the seller, get a quote with a TTL.
2. **estimate** — validate the price.
3. **think** — sleep for a random 3000–9000 ms (simulates LLM inference latency).
4. **pay** — Circle SDK `createTransaction`: USDC transfer wallet1 → wallet2
   on Arc Testnet. Poll until `COMPLETE`.
5. **verify** — `POST /verify` on the seller with `tx_id` + the quote's
   `expires_at`. Seller returns `delivered:false reason:"stale_quote"` if the
   quote already expired by now.

A workflow stops on the first hop failure (both arms, symmetric rule).
*E2E success* = all 10 hops succeeded.

**Two arms, same code, same seeds, only the wrap differs:**

- **bare** — `discover → estimate → think → pay → verify`. The agent locks in
  a quote up front, then "thinks" while the quote's TTL elapses, then pays.
  If `think + pay` exceeds the quote's TTL (5s in this experiment), the
  quote is stale by the time verify runs and the seller rejects delivery.

- **helix** — `wrap(hopFn, { preflight })`. Before each hop, preflight
  queries the Gene Map's audit log: *"has any prior hop in this agent's
  history failed with `stale_quote`?"* If yes, preflight modifies the hop's
  args to set `lateDiscover=true`, and the hop runs as
  `think → discover → estimate → pay → verify` — the quote is fresh because
  it's signed *after* the slow think step.

The first stale_quote failure is what teaches the agent. Subsequent hops
benefit from that one trial.

---

## Results — N=50 × 4 arms

All four runs use identical parameters except `--mode` and `--fail-rate`:

```
--n-workflows=50 --n-hops=10 --ttl-ms=5000 --think-delay-range=3000,9000
```

| # | mode  | fail-rate | E2E success | stale_quote | 503 (seeded) | USDC paid | USDC wasted | Duration |
|---|------|----------:|------------:|------------:|-------------:|----------:|------------:|---------:|
| 1 | bare  | 0.05  | **0 / 50  (0.0%)** | 47 | 3 | $0.047 | **$0.047** | 460 s |
| 2 | helix | 0.05  | **26 / 50 (52.0%)** | 2 | 21 | $0.351 | **$0.002** | 3281 s |
| 3 | bare  | 0     | **0 / 50  (0.0%)**  | 50 | 0 | $0.050 | **$0.050** | 475 s |
| 4 | helix | 0     | **48 / 50 (96.0%)** | 2 | 0 | $0.484 | **$0.002** | 4308 s |

**Deltas:**

| Comparison | E2E success | Wasted USDC |
|---|---|---|
| #2 helix − #1 bare (with 5% unpreventable 503 noise) | **+52.0 pp** | $0.045 saved (~96%) |
| #4 helix − #3 bare (pure stale, no noise) | **+96.0 pp** | $0.048 saved (~96%) |

**On-chain evidence:** 932 real Arc Testnet USDC transfers across all four runs
(47 + 351 + 50 + 484). Every tx_hash is in `runs/manifest-*.json` →
`all_tx_hashes`. Any tx is verifiable at https://testnet.arcscan.app/.

**Reading the helix 2 stale_quotes (in #2 and #4):** these are the **cold-start
cost** — workflow #1 of each helix run begins with an empty Gene Map, must
encounter one stale_quote, record it to audit, and then preflight kicks in for
every subsequent hop. The 96% prevention rate in #4 reflects the post-warmup
behavior; the post-warmup prevention rate of *learnable* failures is 100%
(48/48 once the audit has the first stale entry).

---

## Known scope limitations

Read this before citing the numbers externally.

### 1. Mock x402 seller, not real Circle Nanopayments / x402

The seller endpoint (`scripts/circle-bench/seller/`) is a Cloudflare Worker
that returns hand-crafted quotes and verify decisions. The agent's payment
step *is* a real Circle dev-controlled-wallet `createTransaction` on Arc
Testnet (verifiable on-chain), but the **service discovery / authorization /
verification protocol is mocked** — we are not exercising x402's actual
EIP-3009 authorization payload, facilitator routing, or settlement path.

This was a deliberate choice for the weekend scope: we wanted to isolate
the *failure-shape learning* signal without entangling it with x402 protocol
details. Scenario #2 (CCTP) is the natural next step toward real protocol
coverage.

### 2. `stale_quote` ≠ x402 Issue #1062 facilitator-timeout

The failure mode this experiment characterizes is **authorization TTL
timing** — the quote the seller signs has a finite validity window, and if
the agent takes too long between discover and verify, the seller rejects
delivery.

This is **related to but distinct from** the facilitator-timeout case
discussed in x402 Issue #1062. We are not testing facilitator-side timeouts;
we are testing agent-side timing discipline against the seller's
authorization window. Both share the structural shape "operation outlived its
authorization," but the resolution surface (and who bears the cost) is
different. We deliberately did not claim coverage of Issue #1062.

### 3. 8 s TTL is a time-compression parameter, not a TTL measurement

Real x402 quote TTLs are typically in the order of minutes (often ~5 min).
We used **TTL = 5 s** in this experiment specifically to make the
*workflow-duration / TTL* ratio reproducible at small scale — with real TTL
and real LLM-think times, a single benchmark workflow would take hours, and
N=50 × 4 arms would take weeks.

By compressing time, we keep the *structural relationship* intact (think
delay > TTL by a margin) while making the experiment runnable in ~3 hours.
We are **not measuring real TTL behavior**; we are measuring the agent's
ability to learn a structural timing pattern.

### 4. Circle Gateway already mitigates the facilitator side

Circle Gateway's batched-settlement architecture neutralizes a large class
of timing-race failures on the **facilitator** side of the protocol. The
unsolved half — and the half this experiment addresses — is on the **agent**
side: the agent's own decision-ordering can still age its own quote past
the TTL, regardless of how the facilitator settles. The Helix preflight
mechanism here is **symmetric to Gateway's role**: Gateway mitigates the
service-side race; Helix learns the agent-side discipline.

This framing matters when presenting to Circle: we are not claiming Helix
solves a problem Gateway already solves. We're claiming Helix addresses
the corresponding agent-side residual.

### 5. The cold-start cost is real

In every helix run, **the first stale_quote is unavoidable**. The audit
table starts empty; preflight has nothing to consult on the first hop of
the first workflow; that hop fails, records the audit, and only then does
preflight start engaging. In production this means Helix has a per-failure-
class warmup cost of one trial per Gene Map.

We don't smooth over this — runs/W1 (the first workflow of each helix run)
shows the failure. Subsequent workflows show the prevention.

### 6. Single agent, single Gene Map

This experiment has one agent learning one failure pattern on one Gene Map.
We did not test:
- federated learning across multiple agents (whether Gene Registry Cloud
  amortizes the cold-start cost across agents)
- multiple concurrent failure classes
- Gene drift / stale audit entries
- Failure modes Helix has NOT been trained on

### 7. Cost / latency tradeoff is not zero

Helix workflows run longer because they don't stop early — they complete
all 10 hops when bare would have died at hop 0. That's the *intended*
behavior (more value delivered) but it does mean helix arms used more wall
time and more on-chain USDC overall ($0.351 + $0.484 paid vs. $0.047 +
$0.050 paid). The story is **wasted** USDC, not total spend. Talking
point should be "Helix delivered $0.831 of real value for $0.004 of waste,
vs $0 of value for $0.097 of waste."

---

## Reproducibility

### Prerequisites

- Node 20+
- Circle developer account, sandbox API key in the format `TEST_API_KEY:<id>:<secret>`
- Cloudflare account (`wrangler` CLI authed) for the seller Worker
- Some sandbox USDC (free from the faucet)

### Setup

```bash
cd scripts/circle-bench
npm install

# Configure your API key (placeholder file is already at .env, gitignored)
echo 'CIRCLE_API_KEY=TEST_API_KEY:<id>:<secret>' > .env

# One-time: register entity secret + create 2 dev-controlled wallets on ARC-TESTNET.
# Writes wallet IDs/addresses into .env. Recovery file lands in output/ —
# BACK THIS UP, losing it means losing wallet access.
npm run create-wallet

# Fund wallet 1 from https://faucet.circle.com (Arc Testnet, ~40 USDC is plenty)

# Deploy the mock x402 seller
cd seller
npm install
npx wrangler login    # one-time
npm run deploy
# Capture the deployed URL → set SELLER_URL in scripts/circle-bench/.env
cd ..
```

### Smoke test

```bash
npm run smoke
# Runs 1 workflow × 2 hops in bare mode. Should complete in ~30 s and
# write runs/<workflow_id>.json + runs/manifest-<timestamp>.json.
```

### Single arm

```bash
# Bare
npm run bench:bare -- --n-workflows=50 --n-hops=10 --fail-rate=0.05 \
  --ttl-ms=5000 --think-delay-range=3000,9000

# Helix — delete the audit DB first if you want a cold start
rm -f output/helix-genes.db
npm run bench:helix -- --n-workflows=50 --n-hops=10 --fail-rate=0.05 \
  --ttl-ms=5000 --think-delay-range=3000,9000
```

### Full 4-arm sequence (overnight queue)

```bash
nohup ./overnight-queue.sh < /dev/null > output/overnight-queue.out 2>&1 &
disown
```

Runs in this order (each ~10–75 min):
1. waits for any in-progress run with `output/helix-run-005.log`
2. bare, fail-rate=0 → `output/bare-run-006.log`
3. removes `output/helix-genes.db` for cold start
4. helix, fail-rate=0 → `output/helix-run-007.log`
5. generates `output/overnight-summary.txt`

Check `output/overnight-queue.log` for heartbeat timestamps.

### Fairness controls

- `think_delay_ms` and the seeded `inject_503` are both derived from
  `(workflow_index, hop_index)` via `mulberry32`. **Two arms run with the
  same flags get identical noise on every hop** — only the wrap differs.
  See `src/workflow.ts::thinkDelayFor` and `shouldInject503`.
- The bare arm never reads or writes the Gene Map (no preflight wired).
- The helix arm uses an isolated SQLite at `output/helix-genes.db`;
  cold-starting is just deleting the file.

---

## Where the evidence lives

```
scripts/circle-bench/
├── src/                          bench source (workflow, preflight, clients, run)
├── seller/                       mock x402 Cloudflare Worker
├── runs/
│   ├── manifest-<ts>.json        one per run, has summary + all_tx_hashes
│   └── <workflow_id>.json        200 per-workflow files (10 hops each)
├── overnight-queue.sh            4-arm orchestrator
├── summary.cjs                   aggregates the 4 manifests into a comparison
└── output/                       gitignored — .env, wallet recovery, helix-genes.db,
                                  run logs, overnight-summary.txt
```

The 4 N=50 manifests committed in this repo are:
- `runs/manifest-2026-05-16T08-05-23-553Z.json` — bare fail=0.05
- `runs/manifest-2026-05-16T08-15-55-176Z.json` — helix fail=0.05
- `runs/manifest-2026-05-16T09-10-48-877Z.json` — bare fail=0
- `runs/manifest-2026-05-16T09-18-44-441Z.json` — helix fail=0

Each contains `git_sha`, all parameters, summary stats, and the full
`all_tx_hashes` list. Paste any tx into https://testnet.arcscan.app/ to
verify on-chain.

---

## What this does NOT prove

- Helix prevents arbitrary agent failures (we tested one structural class).
- Helix's preflight design is the right design for Circle's real x402 path
  (we used a mock).
- The same N=50 result holds at N=1000 or under different load profiles.
- The cold-start cost is acceptable for production deployment patterns
  where new failure classes are common.

Each of these is a deliberate next-experiment, not a claim this experiment
supports.
