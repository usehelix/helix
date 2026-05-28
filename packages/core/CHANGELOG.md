# @helix-agent/core changelog

## 2.8.0 - 2026-05-26

Three Circle-focused PRs landed since 2.7.3: a full Circle platform
adapter, Arc Testnet bench/telemetry data for two of its capsules
(`wallets-api-rate-limit` measured, `stale_quote` real telemetry), and
a standalone v2 strategy module benchmarked against the v1 capsules.
The remaining five Circle capsules ship as structurally-reasoned priors
(q=0.50, successCount=0) — NOT validated by bench or telemetry.

### Added — Circle Platform Adapter

**Platform adapter** (`platforms/circle/`):
- `circlePerceive` recognises Circle SDK errors across BOTH SDK versions:
  raw AxiosError (v7) and the wrapped `class E` (v10+). Reads numeric
  Circle codes from `response.data.code` or top-level `error.code`,
  URL from `error.config.url` / `error.response.config.url` / top-level
  `error.url`. Message-regex and generic-HTTP fallbacks are gated on
  `apiLayer !== null` so the adapter never over-claims non-Circle errors.
- `construct()` produces 15 candidates covering 4 Circle-specific
  failure codes (Group 1) and 11 Circle Web SDK numeric codes (Group 2).
- `circleAdapter` is registered FIRST in `defaultAdapters` — its
  specific URL + numeric-code fingerprint must fire before Privy's
  generic `/429/` regex would claim a Circle rate-limit error.

**ErrorCode union additions** (14 entries):
- `wallets-api-rate-limit` (Circle code 5), `gateway-rate-limit`,
  `gateway-nonce-used`, `cctp-attestation-pending`.
- Web SDK numeric codes: `circle-param-missing` (1),
  `circle-param-invalid` (2), `circle-forbidden` (3),
  `circle-unauthorized` (4), `circle-retry` (9),
  `circle-customer-suspended` (10), `circle-pending` (11),
  `circle-token-expired` (155104), `circle-insufficient-funds`
  (155201 / 155258), `circle-exceed-withdraw-limit` (155203),
  `circle-pending-tx-queue-full` (155264).
- `decimals-metadata-mismatch` (Exp A — one real Arc tx, n=1; ships as
  a q=0.50 prior) and `stale_quote` (Exp D — 48/50 real telemetry, q=0.96).

**FailureCategory union**: added `'infrastructure'` for token-metadata
bugs and native-vs-ERC-20 confusion.

**FailureClassification interface**: added optional `chain?: string`
field for chain-specific bugs (e.g. `'arc-testnet'`, `'base-sepolia'`).
Deliberate decision NOT to widen the `Platform` union to include
`'arc'` — `platform` stays `'circle'` and `chain` carries the sub-chain.

**Repair strategies** (`engine/provider.ts`):
- `serialize_and_backoff` — Wallets API concurrency-lock recovery.
- `burst_then_pace` — Gateway sliding-window pacing.
- `rotate_authorization` — EIP-3009 nonce regeneration via
  `node:crypto.randomBytes`.
- `wait_attestation` — CCTP `iris-api` polling (Node 18+ global fetch).
- `override_api_decimals` — three-priority decimals resolution:
  on-chain `ERC20.decimals()` → native-asset ground-truth table
  (`arc-testnet:usdc=6`, `base-sepolia:usdc=6`, etc.) → caller-supplied
  `expected_decimals`.

**Seed capsules** (7 new Circle entries, each with explicit `apiLayer`).
Only two carry data; the other five are conservative priors (q=0.50,
successCount=0, avgRepairMs=0) — structurally reasoned, not yet validated:
- `wallets-api-rate-limit` → `serialize_and_backoff` (q=0.76, MEASURED in
  Bench 2.1 at 5×20-concurrent; KNOWN load bug — does not serialize
  cross-instance retries, degrades past ~20-concurrent, fix tracked for a
  follow-on PR; see Documented gaps below).
- `stale_quote` → `observe` (q=0.96, REAL telemetry: 48/50 across 932 Arc
  tx). Observe-only: the capsule RECORDS the failure, it does NOT execute
  an in-engine repair — the 96% is the agent's own preflight reorder
  reading this capsule's audit log. Caveat: `late_discover` is only valid
  when the `think` step does NOT consume the quote; see seed gene
  `params.caveat` for alternative repair patterns.
- `gateway-rate-limit` → `burst_then_pace` (q=0.50 prior, unvalidated).
- `gateway-nonce-used` → `rotate_authorization` (q=0.50 prior, unvalidated).
- `cctp-attestation-pending` → `wait_attestation` (q=0.50 prior, unvalidated).
- `circle-param-invalid` → `hold_and_notify` (q=0.50 prior, unvalidated).
- `decimals-metadata-mismatch` → `override_api_decimals` (q=0.50 prior;
  one real Arc tx `0x113addf1…81d07` demonstrated the correction, n=1 —
  a single observation, not a validated success rate).

**End-to-end demo** (`examples/circle-e2e.ts`): 5-scenario live demo
against Circle Sandbox + Arc Testnet, producing real Arc tx hashes:
1. Rate limit (10 concurrent → IMMUNE → `serialize_and_backoff`;
   succeeds at low concurrency only — see load-degradation gap below).
2. Param invalid (idempotencyKey trigger → IMMUNE → `hold_and_notify`).
3. Insufficient funds (overdraft → IMMUNE → `reduce_request`).
4. Decimals override (10^12 amount inflation → IMMUNE →
   `override_api_decimals` via ground-truth table).
5. Stale quote advisory (synthetic `STALE_QUOTE` → IMMUNE → `observe`,
   3 repair options surfaced for the caller).

**Diagnostic harnesses** (`scripts/circle-bench/`):
- `perceive-trace.ts` — verifies which platform adapter claims a given
  error (used to diagnose the chain-ordering and dual-SDK-shape issues).
- `probe-error-shapes.ts` — dumps raw Circle SDK error structure
  (constructor, fields, axios markers) for triage.

### Added — Standalone Circle v2 Strategies (`strategies/circle-v2/`)

Three pure-function strategies, deliberately NOT yet integrated into
the PCEC engine. The Gene Map's v14 schema doesn't support multiple
strategies per `failureCode`; Gene Map multi-strategy support is a
follow-on PR. v2 strategies are bench-validated against their v1
counterparts using identical Arc Testnet inputs.

- `chunkConcurrent(operations, { chunkSize, interChunkPauseMs, adaptive })`
  — proactive rate-limit pacing. Bench 2.1 (20-concurrent × 5 trials)
  shows 100% reliability vs v1's 76% (24 of 100 transfers permanently
  lost under sustained load), in exchange for 53% slower wall clock.
  Adaptive shrinks `chunkSize` by 1 on observed 429s.
- `smartParamRepair(error)` + `applyParamRepair(args, action)` —
  routed param-error recovery. Bench 2.2 routing (5 scenarios × 20
  reps, offline) achieves 80% auto-fix vs v1's 0%. Bench 2.4
  (real Arc Testnet, 3 groups × 20 trials) confirms end-to-end:
  20/20 idempotencyKey strip → real tx submission, 20/20
  `'not-a-uuid'` walletId → correct hold-and-notify with UUID
  diagnostic. Discriminated-union action types: `strip_field`,
  `coerce_type`, `normalize_address`, `inject_default`,
  `refresh_metadata`, `hold_and_notify`.
- `verifyTokenMetadata(apiMetadata, { publicClient, chain, cache })`
  — generalised token-metadata verification. Bench 2.3 (4 scenarios
  × 50 iter) shows v2 catches symbol drift (`USDC` → `USDC.e`) which
  v1's `override_api_decimals` misses entirely. Three-priority
  resolution (on-chain ERC-20 reads → ground-truth table → API-trusted)
  with `MetadataTrustResult.source` audit-attribution. Exported
  `NATIVE_USDC_DECIMALS` table (frozen) covers Arc, Base, Avalanche,
  Ethereum and their testnets.

### Changed

- `defaultAdapters` chain reordered: `circle → tempo → privy →
  coinbase → stripe → generic` (was `tempo → privy → coinbase →
  circle → stripe → generic`). Circle's specific URL+code
  fingerprint must precede privy's generic `/429/` regex.
- `circlePerceive` gates message-regex and generic-HTTP fallback
  blocks on `apiLayer !== null` to prevent over-claiming on plain
  errors that happen to mention `"insufficient"` / `"503"` / `"429"`
  but originate from non-Circle sources.

### Validated (real tx hashes on Arc Testnet)

- Decimals override (PR #2 demo + PR #3 Bench 2.4): real
  `createTransaction` submitted after Helix corrected a 10^12 amount
  inflation via ground-truth table (single demonstration tx, n=1 — not
  a statistical success rate; capsule ships as a q=0.50 prior).
- Rate-limit reliability (PR #3 Bench 2.1, 5 trials × 20-concurrent):
  v1 = 76% success / 24 lost transfers; v2 `chunk_concurrent` =
  **100% success / 0 lost**.
- Smart param repair (PR #3 Bench 2.4 Group A): 20/20 idempotencyKey
  rejections recovered via `strip_field` with real Arc tx submission.

### Documented gaps for follow-up PR

- `scripts/circle-bench/results/v1-serialize-and-backoff-anomaly.md` —
  v1's `serialize_and_backoff` doesn't actually serialise the 5
  concurrent retries; under sustained load (20-concurrent) all 5
  retries race the same rate-limit window and 24% of transfers are
  permanently lost. Marked for fix alongside Gene Map multi-strategy.
- `scripts/circle-bench/results/refresh-metadata-reachability.md` —
  the v2 `refresh_metadata` action is currently un-reachable through
  observed Circle Sandbox error shapes (nil-UUID returns
  `uuid_format`; well-formed-but-unknown UUID returns HTTP 404 +
  code 156002 with no `errors[]` array). The router correctly holds
  in both cases. Follow-on PR will add a 156002 numeric-code branch.

### Tests

- packages/core unit tests: 570 → 623 (+53 across the three v2
  strategy modules: chunk_concurrent +8, smart_param_repair +24,
  metadata_trust +21). Existing 570 are unchanged.
- v2 strategies are standalone (not wired into PCEC), so the
  cross-platform / pcec / e2e-pipeline integration tests do not
  need updates.

### Notes for downstream consumers

- The `Platform` union was deliberately NOT widened to include
  `'arc'` — Arc-specific bugs use the new `chain?: string` field
  instead, keeping `platform: 'circle'` for all Circle-routed errors.
- `WrapOptions.context` is the canonical place to thread per-call
  state (e.g. `publicClient`, `tokenAddress`, `expected_decimals`)
  into PCEC; seed-gene `params` are reference values stored
  alongside capsules but not auto-merged into context.
- `wallets-api-rate-limit` perceive routing previously sat inside an
  `apiLayer === 'wallets-api'` guard; it now fires unconditionally
  from the numeric block since SDK v10's error message doesn't
  contain the URL needed for the apiLayer guard.
- v2 strategies in `strategies/circle-v2/` are NOT yet routed through
  `wrap()`. Bench scripts call them directly. Treat them as a preview
  of the multi-strategy Gene Map work — public API may change before
  PCEC integration.

---

## 2.7.3 - 2026-05-08

### Added
- **Trace-aware LLM Construct fallback** (Hermes/GEPA-inspired): when Gene Map
  misses and adapter has no candidates, the LLM prompt now includes the last 3
  same-error-code repair traces (✓/✗, q-value transitions, failure reasons)
  from `repair_audit + failed_repairs`. The LLM gets medical-record context
  instead of the bare error code. New helper: `geneMap.getRecentTraces()`.
- **Gene Registry Cloud consumer**: PCEC now syncs successful repairs to a
  shared Registry (fire-and-forget POST `/v1/capsules`) and queries the
  Registry on local Gene Map miss (200ms blocking, falls through to
  adapter+LLM on timeout). Configure via env vars `GENE_REGISTRY_URL`,
  `GENE_REGISTRY_WRITE_KEY`, `GENE_REGISTRY_AGENT_ID`, or via
  `WrapOptions.registry`. New module: `engine/registry-bridge.ts`.
- `RepairCandidate.source` union now includes `'registry'` to mark candidates
  that came from cross-agent procedural memory.
- New `PcecEngine.getMetrics()` exposing Registry counters
  (`registrySyncCount`, `registryQueryCount`, `registryQueryHits`, etc.) for
  observability dashboards.

### Deprecated
- `GeneRegistryClient` (legacy batch push/pull client). Targets a different
  API surface (`/v1/genes/push`) than the production worker. PCEC no longer
  instantiates it. Kept for type-import backward compatibility; will be
  removed in v3.0.
- `WrapOptions.registry.minQualityForPush`, `minQualityForPull`,
  `syncIntervalMs`, `pushBatchSize`, `pullBatchSize` — legacy batch knobs,
  silently ignored. Use `writeKey` and the new per-commit fire-and-forget model.
- `WrapOptions.registry.apiKey` — fall back only. Use `writeKey` instead.

### Fixed
- (none in this release)

### Tests
- 553 → 570 (+13 registry-bridge unit tests, +3 trace-aware unit tests,
  +1 trace-aware e2e test)

### Validated
- Cross-DB procedural memory reuse: 99% LLM call reduction in synthetic
  100%-miss stress workload (Run 1 populator → Run 2 fresh-DB consumer).
  See `reports/dogfood-dual-run-may8.md`.

