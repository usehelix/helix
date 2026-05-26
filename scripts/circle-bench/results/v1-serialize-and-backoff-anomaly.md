# Anomaly: `v1 serialize_and_backoff` does not actually serialize retries

**Status:** Documented; not yet fixed. Recommended fix-target is PR #4
(alongside Gene Map multi-strategy migration).

**Source:** `packages/core/src/engine/provider.ts` — `case 'serialize_and_backoff'`

**Bench data reference:** `scripts/circle-bench/results/v1-vs-v2-rate-limit-2026-05-26T06-19-41.json`

---

## Observed behaviour (Bench 2.1, May 26 2026)

5 trials × 20 concurrent USDC transfers on Arc Testnet.

```
trial 1: 4807ms · ok=15/20 · 429s=5
trial 2: 4660ms · ok=15/20 · 429s=5
trial 3: 4685ms · ok=15/20 · 429s=5
trial 4: 4791ms · ok=15/20 · 429s=5
trial 5: 4857ms · ok=16/20 · 429s=4

avg: 4760ms · 76% success · 24× 429 across 100 attempts
```

For each trial:

1. 20 transfers fire concurrently via `Promise.allSettled`.
2. Circle returns 429 on ~5 of them (≈5-concurrent ceiling per PR #2's
   probe data).
3. The 5 failed wraps independently engage PCEC.
4. PCEC picks the `wallets-api-rate-limit + serialize_and_backoff`
   capsule (q=0.95) and commits the strategy.
5. `case 'serialize_and_backoff'` executes
   `await sleep(min(delay, 5000))` — a single 2-second sleep — then
   returns `success: true` with `_helix_serialize: true` in overrides.
6. Each of the 5 wraps **independently retries in parallel** after its
   own 2-second sleep.
7. The 5 retries arrive at Circle within the same rate-limit window
   and **all hit 429 again**.
8. Self-refine logs `Strategy "serialize_and_backoff" failed 2 times
   — no alternative found` and gives up.
9. 5 transfers (4 in one trial) are permanently lost.

## Expected behaviour

The strategy name implies that retries are **serialized** — at most
one in flight at a time. Either:

- (a) the engine queues retries through a shared concurrency
  controller (e.g. a per-wallet semaphore), or
- (b) the strategy's commit signals the wrap layer to engage a
  process-wide serialization gate before retrying, and the wrap
  layer enforces it.

Today's implementation does neither. The `_helix_serialize: true`
override flag is set in commit overrides but **no caller reads it**.
parameterModifier patterns in `examples/circle-e2e.ts` only mutate
visible args (idempotencyKey, amount); they don't enforce
serialization.

## Why this didn't show up in PR #1's demo

The PR #1 demo runs **10** concurrent transfers (not 20). At 10
concurrent on the May 2026 Sandbox, ~5 fail with 429. After the 2s
sleep, the 5 retries hit a window that has already partially reset,
and most of them succeed. The demo shows
"IMMUNE wallets-api-rate-limit serialize_and_backoff ✓" because the
underlying Circle call DID succeed on retry — just not because of
serialization.

At 20 concurrent, the rate-limit window stays saturated longer; the
5 parallel retries all land in the still-throttled window and fail.

## Source location to fix

```ts
// packages/core/src/engine/provider.ts (approx. lines 386-396, post-PR#1)
case 'serialize_and_backoff': {
  const delay = Number(context?.retryAfterMs ?? context?.defaultDelayMs) || 2000;
  await sleep(Math.min(delay, 5000));
  return {
    success: true,
    overrides: { _helix_serialize: true, _helix_concurrency: 1 },
    description: `Serialized retry after ${delay}ms (Wallets API concurrency lock)`,
  };
}
```

`_helix_serialize` / `_helix_concurrency` are set but never consumed.
The wrap layer in `engine/wrap.ts` has no per-context concurrency gate.

## Recommended fix path

**Option A — Process-wide async mutex per (apiLayer, walletId).**
Cleanest. The strategy commit acquires the mutex; the retry runs
under it; releases on completion or timeout. Survives across
unrelated wrap instances. Requires a new `MutexRegistry` module.

**Option B — Move serialization into the strategy itself.**
The strategy returns `success: false` and a queue-key in overrides;
the wrap layer queues the next retry behind any in-flight retry with
the same key. Less invasive but requires wrap.ts changes.

**Option C — chunk_concurrent path replaces serialize_and_backoff
for this failure code entirely.** Bench 2.1 v2 demonstrated chunk
pacing achieves 100% success with predictable latency. The "serialize
on demand after a 429" pattern is fundamentally lossy when retries
race; proactive pacing avoids the race.

PR #4 is positioned to make this swap via Gene Map multi-strategy
(both capsules registered for the same `failure_code`, picked by
Thompson Sampling at runtime, with the loser pruned by Q-value
decay).

## Why we discovered this through systematic comparison

Bench 2.1's first run at 10-concurrent showed **both v1 and v2 at
100% success** — the v1 anomaly was invisible because the retry
race was masked by the rate-limit window resetting in time. Only
when we cranked to 20-concurrent did v1's 24% loss appear, and the
self-refine error messages
(`Strategy "serialize_and_backoff" failed 2 times`) made the parallel
retry pattern visible.

The walkthrough can frame this honestly: PR #2's `serialize_and_backoff`
seed worked in dev (10 concurrent), failed under sustained load
(20+ concurrent), and PR #3's `chunk_concurrent` replaces it with a
proactive pacing model that survives the sustained-load regime.

---

**Do not fix in this PR.** Document, run benches, ship the data.
Fix in PR #4 once Gene Map multi-strategy support lands.
