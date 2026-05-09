# @helix-agent/core changelog

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

