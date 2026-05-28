# Known Issues — @helix-agent/core

Tracked honesty-debt and known-broken behavior. Surfaced by the 2.8.1 audit.

---

## KI-1 — `serialize_and_backoff` does not serialize (no-op)

- **Tracking:** https://github.com/usehelix/helix/issues/9
- **Status:** open · **Severity:** high (repair-flawed) · **Target:** PR #4
- **Surfaced by:** 2.8.1 audit; `scripts/circle-bench/results/v1-serialize-and-backoff-anomaly.md`

The `serialize_and_backoff` strategy (Circle `wallets-api-rate-limit`) sets
`_helix_serialize` / `_helix_concurrency` override flags that **no caller ever
reads**. It then sleeps once (~2s) and retries — **in parallel** — so under real
concurrency the retries land in the same rate-limit window and all 429 again.
Bench 2.1 (5×20-concurrent Arc Testnet) showed the repair recovered ~0% of
rate-limited calls; the measured "76%" was ambient first-attempt API acceptance.

- **Consequence:** `wallets-api-rate-limit` was demoted to q=0.50 (detection-only)
  in 2.8.1 and flagged KNOWN-BROKEN inline (`seed-genes.ts`, `platforms/circle/strategies.ts`).
- **Do NOT** re-validate or re-raise this capsule's q-value without first
  implementing real serialization (per-wallet semaphore, or a wrap-layer
  concurrency gate that consumes `_helix_concurrency`). The v2 `chunk_concurrent`
  path (`scripts/circle-bench/`) is the intended replacement.

---

## KI-2 — Immune-stat inflation: halts count as "immune successes"

- **Tracking:** https://github.com/usehelix/helix/issues/10
- **Status:** open · **Severity:** high (honesty-debt) · **Target:** 2.8.2 / 2.9.0
- **Surfaced by:** 2.8.1 audit (`pcec.ts` immune branch)

`PcecEngine.repair()` increments `stats.immuneHits` and `stats.savedRevenue`, and
records `immune: true` in the audit log, for **any** existing gene with
`qValue > 0.3` — **including `hold_and_notify` / `nonRepairable` capsules that do
not complete the original call.** A capsule that merely *halts* (e.g.
insufficient-funds) therefore counts toward "immune success" and "saved revenue".

- **Consequence:** every published `immuneHits` / `savedRevenue` figure is
  **inflated by halts** and cannot be cleanly read as "repairs that completed the
  original intent."
- **Until fixed, do NOT cite `immuneHits` or `savedRevenue` in external
  material.** Distinguish repair-completions from correct-halts in the stats:
  e.g. exclude `nonRepairable` genes (and `observe`-mode capsules) from
  `immuneHits`/`savedRevenue`, or split into `repairHits` vs `haltHits`.
