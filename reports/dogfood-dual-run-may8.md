# Gene Registry Cloud — Dogfood Dual-Run Report

**Date:** 2026-05-08
**Branch:** main (pre-commit, awaiting review)
**Worker:** `https://helix-telemetry.haimobai-adrian.workers.dev`
**Script:** `packages/core/scripts/stress-test-dogfood.ts`

This report documents the first end-to-end validation of `@helix-agent/core`
consuming the Gene Registry Cloud Worker that shipped earlier on 2026-05-08.
The hypothesis being tested: a fresh agent on a different local Gene Map can
inherit procedural memory from a previous agent purely by reading from the
shared Registry.

---

## Test design

- **100 unique synthetic failure codes** per run (`dogfood-may8-stress-000` …
  `dogfood-may8-stress-099`), so neither run benefits from in-run repetition
  via the local immune path.
- LLM HTTP calls mocked at script level (returns `retry`) — no real OpenAI/
  Anthropic traffic, no API keys needed for the stress test.
- Registry HTTP calls go through to the real production worker (Cloudflare
  D1-backed).
- Each run uses an isolated SQLite database (`/tmp/run1.db`, `/tmp/run2.db`)
  and a distinct `GENE_REGISTRY_AGENT_ID`.
- Same `STRESS_RUN_TAG=dogfood-may8` so Run 2 queries the codes Run 1 just
  populated — this is the cross-machine reuse signal.

---

## Run 1 — `helix-core-mac-haimo` (populates the Registry)

Fresh `/tmp/run1.db`. Registry has 27 SEED baseline + nothing for our
synthetic dogfood-may8 codes. Every code is novel from the Registry's
perspective.

```
┌─────────────────────────────────────────┐
│ Stress Test Results                     │
├─────────────────────────────────────────┤
│ Errors injected:        100             │
│ Local Gene Map hits:    0               │
│ Registry queries:       100             │
│ Registry hits:          0               │
│ Registry timeouts:      1               │
│ LLM Construct calls:    100             │
│ Successful repairs:     100             │
│ Capsules synced:        100             │
│ Sync failures:          0               │
│ Total time:             59.4s           │
└─────────────────────────────────────────┘
```

Reading: every one of 100 errors missed both local Gene Map (fresh) and
Registry (novel codes). LLM Construct fired 100 times, returning the
canned `retry` strategy. Provider executed it (built-in 500ms sleep
strategy). On commit success, capsule was pushed to Registry. 100 new
capsules now exist on the worker, each tagged with
`agent_id=helix-core-mac-haimo`.

Single 200ms timeout was the first cold-start request to the worker.

---

## Run 2 — `helix-core-mac-fresh-b` (consumes the Registry)

Fresh `/tmp/run2.db`, different agent ID, **same** `STRESS_RUN_TAG`. The
worker now holds 100 capsules from Run 1 keyed on `dogfood-may8-stress-N`.

```
┌─────────────────────────────────────────┐
│ Stress Test Results                     │
├─────────────────────────────────────────┤
│ Errors injected:        100             │
│ Local Gene Map hits:    0               │
│ Registry queries:       100             │
│ Registry hits:          99              │
│ Registry timeouts:      1               │
│ LLM Construct calls:    1               │
│ Successful repairs:     100             │
│ Capsules synced:        100             │
│ Sync failures:          0               │
│ Total time:             60.1s           │
└─────────────────────────────────────────┘
```

Reading: 99 of 100 errors hit the Registry on first lookup, immediately
producing a `RepairCandidate { source: 'registry' }` that flowed into
Evaluate→Commit. The single LLM call is exactly the one Registry timeout —
when the worker took >200ms (one cold-ish stretch), PCEC fell through to
LLM Construct as designed. No error, just degraded path.

The same 100 capsules were re-synced from Run 2 (different agent_id), so
the worker's row for each code now records `helix-core-mac-fresh-b` as the
most recent contributor.

---

## Pass-criteria evaluation

| Criterion | Required | Run 2 actual | Pass |
|---|---|---|---|
| Run 2 Local hits | = 0 | 0 | ✅ |
| Run 2 Registry hits | ≥ 50 | **99** | ✅ |
| Run 2 LLM calls | < Run 1 × 0.5 (= 50) | **1** (99% reduction) | ✅ |
| Run 2 Capsules synced | > 0 | 100 | ✅ |

**All four pass.**

---

## Headline numbers

|  | Run 1 (populator) | Run 2 (consumer) | Δ |
|---|---:|---:|---:|
| LLM Construct calls | 100 | 1 | **−99%** |
| Registry hits | 0 | 99 | n/a |
| Capsules synced | 100 | 100 | 0 |
| Successful repairs | 100 | 100 | 0 |
| Wall time | 59.4 s | 60.1 s | +1.2% |

Wall time is dominated by the provider's `retry` strategy executing a 500ms
sleep on every repair (`100 × 500ms = 50s` just for that), so the LLM
reduction does not show up in the wall-clock. The user-visible win is the
LLM **cost** reduction (99 fewer LLM calls × ~$0.01–0.05 per call ≈
$1–5 saved per 100-error run on Run 2 alone — and this scales with
agent fleet size).

---

## Registry-side observations

`GET /v1/stats` after both runs:

```json
{
  "capsules": 130,
  "agents": 2,
  "repairs": 1228,
  "top_errors": [
    { "code": "server-error",       "count": 36 },
    { "code": "nonce-mismatch",     "count": 30 },
    { "code": "rate-limited",       "count": 30 },
    { "code": "payment-insufficient", "count": 24 },
    { "code": "timeout",            "count": 20 }
  ]
}
```

`130 capsules` = 27 SEED baseline + 100 dogfood + 3 leftover smoke-test rows
(intentionally retained for evidence; cleanup query in `workers/REGISTRY_RUNBOOK.md`).
`agents: 2` confirms both Run 1 and Run 2 contributed under their distinct
`agent_id`s — provenance preserved.

`top_errors` is dominated by SEED-baseline rows because each dogfood capsule
has `total_count=1` while SEED rows record higher historical counts. This is
correct behavior and a useful signal that dogfood writes did not pollute the
ranked-strategy view.

---

## Caveats

- **Same physical machine.** Both runs were on the same Mac, only differing
  by SQLite file path and agent ID. This is the agreed-upon proxy for true
  cross-machine isolation (Path E in design call). Real CI / VM isolation
  graduates to a separate verification step when we have that infrastructure.
- **Synthetic codes.** `dogfood-may8-stress-N` codes are not real-world error
  patterns — they exist to give us 100 unique `(failure_code, platform)`
  combinations that all the existing perceive logic would otherwise classify
  as `unknown`. The integration path (lookup → Registry query → Construct
  → Commit → audit → sync) is identical to production; only the failure
  detection is short-circuited via a stress-only adapter.
- **LLM mocked.** No real LLM was called. The mock returns `retry` for every
  Construct request. The point of the stress test is the Registry path,
  not LLM behavior; trace-aware Construct (shipped earlier today) has its
  own e2e test for that.
- **One Registry timeout per run.** 200ms blocking timeout is tight for
  Cloudflare Workers cold starts. We accept the ~1% miss rate as a sane
  tradeoff vs. blocking the PCEC hot path indefinitely. Worth revisiting
  if observed timeout rate ever exceeds ~5%.
- **Wall-clock is not the metric.** The 60s/run is dominated by the
  provider's `retry` 500ms sleep × 100. Any future stress test that wants
  to surface latency wins from Registry should use a no-sleep strategy.

---

## What this proves

1. `@helix-agent/core` now correctly consumes the Gene Registry Cloud worker
   that shipped earlier today via `engine/registry-bridge.ts`.
2. Per-commit fire-and-forget sync works (100 capsules, 0 sync failures,
   no impact on hot-path latency in either run).
3. Per-miss blocking query with 200ms timeout works (99% hit rate in Run 2,
   degrades cleanly to LLM on the rare timeout).
4. The "Git for agent execution experience" thesis ships: a fresh agent on
   a separate local Gene Map can inherit ~100% of another agent's procedural
   memory through nothing more than `npm install + 1 env var`. No code
   sharing, no model retraining, no human-authored knowledge transfer.
5. Real cross-machine validation (CI runner / actual second box) is the
   next step but not blocking; the shared-state mechanism is now wired,
   tested under load, and visibly producing the expected metric pattern.
