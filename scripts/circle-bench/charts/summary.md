# Circle × Helix — Scenario #1 chart summary

Headline numbers and chart artifacts for the Monday deck. Workflow indices
are 1-based throughout (W1 = first workflow in the sequence).

## Headline (fail-rate=0 arms, cleanest comparison)

- Bare agent (no Helix wrap):     **0/50 (0%) E2E success**
- Circle agent + Helix wrap:      **48/50 (96%) E2E success**
- Delta:                          **+96pp**
- USDC wasted (bare → helix):     **$0.050 → $0.002**
- USDC waste reduction:           **96%**

## All four N=50 runs

| # | mode  | fail-rate | E2E success | stale | 503 | infra | USDC paid | USDC wasted | Duration |
|---|------|----------:|---|---:|---:|---:|---:|---:|---:|
| 1 | bare  | 0.05 | 0/50 (0.0%) | 47 | 3 | 0 | $0.047 | **$0.047** | 460s |
| 2 | helix | 0.05 | 26/50 (52.0%) · excl-infra 26/49 (53.1%) | 2 | 21 | 1 | $0.351 | **$0.002** | 3281s |
| 3 | bare  | 0    | 0/50 (0.0%) | 50 | 0 | 0 | $0.050 | **$0.050** | 475s |
| 4 | helix | 0    | 48/50 (96.0%) | 2 | 0 | 0 | $0.484 | **$0.002** | 4308s |

Helix stale counts split: **1 cold-start + 1 pay-tail-latency** in each helix arm (see Chart 2).

## Two deltas

| comparison | E2E | wasted USDC |
|---|---|---|
| #2 helix − #1 bare (fail=0.05, excl infra) | 0.0% → 53.1% (**+53.1pp**) | $0.047 → $0.002 (96% saved) |
| #4 helix − #3 bare (fail=0, no noise)      | 0.0% → 96.0% (**+96.0pp**) | $0.050 → $0.002 (96% saved) |

## Learning-curve story (Chart 2 — helix fail=0)

The curve is monotonic: each successful workflow advances by `100/N` pp;
failures pause the climb. Final value = 48/50 = 96%.

- **48 of 50** workflows succeeded
- **1 cold-start failure** at **W1** (Gene Map empty — the necessary learning trial that writes the audit entry unlocking preflight for the rest of the run)
- **1 pay-tail-latency failure** at **W8** (preflight ran correctly,
  `late_discover=true` applied, but Circle's `createTransaction` returned
  `COMPLETE` after 8 758 ms — exceeding the 5 s TTL regardless of agent
  ordering. Outside current preflight reach; a joint-roadmap item.)

The 1 infrastructure failure (1 × `read ECONNRESET`) in run #2 was at **W32**
and is excluded from the experimental denominator.

## Sample on-chain tx hashes

(verifiable at https://testnet.arcscan.app/tx/<hash>)

| arm | tx hash |
|---|---|
| Helix #4 (fail=0)    | `0x2f60c495eccc23c4c3ca97a5997d5e35e94411ed9038816d07338991a2b5daa7` |
| Helix #2 (fail=0.05) | `0x6b6064d607ab34b4c11568e27cf7b4ed6c7362086e04b4be50c819228e274394` |
| Bare  #3 (fail=0)    | `0x84da26e368502fe5d5cc268510d51b7077c17a4b208c1dfc40739a7490f0663c` |

Full lists: `runs/manifest-*.json` → `all_tx_hashes` (47 + 351 + 50 + 484 = **932** total Arc Testnet USDC transfers).

## Methodology

- Mock x402 seller (Cloudflare Worker) with deterministic `/verify` based on
  quote `expires_at` (no random `stale_quote` injection).
- Real Circle dev-controlled wallet `createTransaction` USDC transfers on Arc Testnet.
- Workflow = 10 sequential hops; each hop = discover → estimate → think → pay → verify.
- think_delay (3000–9000 ms) and 503 injection both seeded by (workflow_index, hop_index)
  via mulberry32, so both arms see identical noise on every hop.
- Bare: discover → estimate → think → pay → verify (quote ages during think+pay).
- Helix: preflight queries Gene Map audit log; on prior stale_quote, sets `lateDiscover=true`,
  reordering to think → discover → estimate → pay → verify (quote is fresh).
- TTL = 5s in this experiment is a deliberate time-compression of real ~5min TTLs to
  reproduce the workflow-duration / TTL ratio at small scale. Not a TTL measurement.

## Known scope limitations (recap)

- Mock x402 seller — not Circle's real Nanopayments / x402 path.
- `stale_quote` ≠ x402 Issue #1062 facilitator-timeout (related but distinct).
- Circle Gateway addresses facilitator-side timing race; Helix addresses the
  symmetric agent-side residual.
- Cold-start cost: one failure per Gene Map per failure class (W1 of each helix run).
- Pay-tail-latency: current preflight does NOT address `pay alone > TTL`. That's a
  joint-roadmap item (richer agent policy + Circle settlement-latency signal).

See `scripts/circle-bench/README.md` for the full writeup.
