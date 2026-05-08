# Gene Registry Cloud — Operational Runbook

Worker: `helix-telemetry` → `https://helix-telemetry.haimobai-adrian.workers.dev`
Backing store: Cloudflare D1 (`gene-registry`) + KV (`HELIX_TELEMETRY`, legacy telemetry)

This document is the source of truth for operating the registry: how to deploy,
how to verify a deploy, how to investigate problems, and how to roll back.

---

## Endpoints

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/v1/capsules?code=&category=&platform=` | GET | none | Pull best capsule (highest q_value) for an error |
| `/v1/capsules` | POST | `x-registry-key` header | Push a capsule from local Gene Map |
| `/v1/stats` | GET | none | Registry counters (capsules, agents, repairs, top errors) |
| `/v1/repair?ec=&platform=` | GET | none | Legacy KV-backed strategy lookup (kept for back-compat) |
| `/v1/event` | GET/POST | none | Legacy KV telemetry write (kept for back-compat) |

D1 stores capsules; KV stores legacy event aggregates. They do not share data.

---

## Required env / secrets

| Name | Where | Notes |
|---|---|---|
| `REGISTRY_WRITE_KEY` | Worker secret (set via `wrangler secret put`) | 64-hex (256-bit). Required to POST capsules. Worker fail-closes (503) if missing. |
| `GENE_REGISTRY_WRITE_KEY` | Local `.env.local` (gitignored) | Same value as worker secret. Used by SDK and seed script. |
| `GENE_REGISTRY_URL` | Local env (optional) | Defaults to the production worker URL when unset. |

---

## Deploy from scratch

Run from `/Users/haimo/Projects/helix`. Wrangler must be logged in (`wrangler login`).

```bash
# 1. Sanity-check migration syntax against the same engine D1 uses, zero side effects
sqlite3 :memory: < workers/migrations/0001_gene_registry.sql

# 2. Apply migration to local .wrangler state (real schema validation, still safe)
cd workers && npx wrangler d1 execute gene-registry --local \
  --file=migrations/0001_gene_registry.sql

# 3. Verify local schema looks right
npx wrangler d1 execute gene-registry --local \
  --command="SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name"
# expect: capsules, idx_capsules_lookup, registry_stats, sqlite_*

# 4. Apply to remote D1
npx wrangler d1 execute gene-registry --remote \
  --file=migrations/0001_gene_registry.sql

# 5. Verify remote schema
npx wrangler d1 execute gene-registry --remote \
  --command="SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name"

# 6. Generate + upload the write secret (also save locally for the seed script)
KEY=$(openssl rand -hex 32)
printf "%s" "$KEY" | npx wrangler secret put REGISTRY_WRITE_KEY
printf "GENE_REGISTRY_WRITE_KEY=%s\n" "$KEY" >> /Users/haimo/Projects/helix/.env.local
unset KEY

# 7. Deploy
npx wrangler deploy
```

---

## Smoke test

Run from repo root after a deploy. Expected outputs are inline.

```bash
cd /Users/haimo/Projects/helix
source .env.local   # loads GENE_REGISTRY_WRITE_KEY
WORKER=https://helix-telemetry.haimobai-adrian.workers.dev
```

### (a) POST without key → 401

```bash
curl -sS -X POST "$WORKER/v1/capsules" \
  -H "Content-Type: application/json" \
  -d '{"failure_code":"smoke-test","strategy":"smoke_strategy"}' \
  -w "\nHTTP %{http_code}\n"
```
Expected: `HTTP 401`, body `{"error":"unauthorized"}`.

### (b) POST with wrong key → 401

```bash
curl -sS -X POST "$WORKER/v1/capsules" \
  -H "Content-Type: application/json" \
  -H "x-registry-key: WRONG_KEY" \
  -d '{"failure_code":"smoke-test","strategy":"smoke_strategy"}' \
  -w "\nHTTP %{http_code}\n"
```
Expected: `HTTP 401`.

### (c) POST with correct key → 200

```bash
curl -sS -X POST "$WORKER/v1/capsules" \
  -H "Content-Type: application/json" \
  -H "x-registry-key: $GENE_REGISTRY_WRITE_KEY" \
  -d '{"failure_code":"smoke-test","category":"smoke","platform":"smoke","strategy":"smoke_strategy","q_value":0.99,"success_count":1,"total_count":1,"agent_id":"smoke-test","sdk_version":"0.1.0"}' \
  -w "\nHTTP %{http_code}\n"
```
Expected: `HTTP 200`, body `{"ok":true}`.

### (d) GET without auth returns the capsule

```bash
curl -sS "$WORKER/v1/capsules?code=smoke-test" -w "\nHTTP %{http_code}\n"
```
Expected: `HTTP 200`, body `{"found":true,"capsule":{...,"strategy":"smoke_strategy","q_value":0.99,...}}`.

### (e) Stats reflects 1 capsule

```bash
curl -sS "$WORKER/v1/stats" -w "\nHTTP %{http_code}\n"
```
Expected: `capsules: 1`, `agents: 1` (`smoke-test`), `repairs: 1`.

### (f) Run seed script (27 baseline capsules)

```bash
npx tsx scripts/seed-registry.ts
```
Expected: `Done — 27 ok, 0 failed`, then `✓ Verification: registry reports capsules=28 (>= 27 pushed).` Exit 0.

### (g) Stats after seed

```bash
curl -sS "$WORKER/v1/stats"
```
Expected: `capsules: 28` (27 seed + 1 smoke), `agents: 1`, `repairs: 28`.

### (h) Spot-check a seeded capsule

```bash
curl -sS "$WORKER/v1/capsules?code=nonce-mismatch&platform=tempo"
```
Expected: `found:true`, `strategy:"refresh_nonce"`, `q_value:0.85`.

### (i) Cleanup the smoke row

```bash
cd workers && npx wrangler d1 execute gene-registry --remote \
  --command="DELETE FROM capsules WHERE failure_code='smoke-test'"
cd ..
```
Expected: `1 row affected`.

### (j) Final stats — should now read 27

```bash
curl -sS "$WORKER/v1/stats"
```
Expected: `capsules: 27`, `agents: 0`. (Note: `repairs` does NOT decrement — it's a true cumulative counter.)

---

## Rotating the write key

```bash
NEW=$(openssl rand -hex 32)
printf "%s" "$NEW" | npx wrangler secret put REGISTRY_WRITE_KEY
# Update .env.local
sed -i.bak "s/GENE_REGISTRY_WRITE_KEY=.*/GENE_REGISTRY_WRITE_KEY=$NEW/" /Users/haimo/Projects/helix/.env.local
rm /Users/haimo/Projects/helix/.env.local.bak
unset NEW
```
After rotation, redeploy any agents using the old key. There is no grace period —
the old key stops working as soon as the new secret is uploaded.

---

## Tail logs (live observability)

```bash
cd workers && npx wrangler tail helix-telemetry --format=pretty
```

Events emitted by the registry endpoints:

| `event` | When |
|---|---|
| `capsule_post_ok` | POST /v1/capsules accepted (logs failure_code, agent_id, q_value, etc.) |
| `capsule_post_unauthorized` | POST without/with wrong x-registry-key |
| `capsule_post_misconfigured` | POST received but worker has no REGISTRY_WRITE_KEY (503) |
| `capsule_post_error` | POST hit a DB error (logs message) |
| `capsule_get_miss` | GET /v1/capsules returned no row (candidate to seed) |

---

## Common D1 inspection queries

```bash
cd workers

# Top N by q_value
npx wrangler d1 execute gene-registry --remote \
  --command="SELECT failure_code, platform, strategy, q_value, success_count, total_count FROM capsules ORDER BY q_value DESC LIMIT 20"

# Per-agent capsule contributions
npx wrangler d1 execute gene-registry --remote \
  --command="SELECT agent_id, COUNT(*) AS capsules, SUM(success_count) AS successes FROM capsules GROUP BY agent_id"

# Capsules updated in the last 24h
npx wrangler d1 execute gene-registry --remote \
  --command="SELECT failure_code, platform, updated_at FROM capsules WHERE updated_at > datetime('now','-24 hours') ORDER BY updated_at DESC"

# Cumulative repair counter
npx wrangler d1 execute gene-registry --remote \
  --command="SELECT * FROM registry_stats"
```

---

## Rollback

The worker source lives at `workers/telemetry-worker.js`. Rollback to the
previous deploy:

```bash
cd workers && npx wrangler rollback
```

If the D1 schema needs to revert (rare — migrations are forward-only), the
correct path is to write a new migration that undoes the change, NOT to drop
tables manually. There is no `wrangler d1 rollback`.

To wipe all capsules without dropping the schema (e.g., for clean re-seed):

```bash
npx wrangler d1 execute gene-registry --remote \
  --command="DELETE FROM capsules; UPDATE registry_stats SET total_repairs = 0 WHERE id = 1"
```

---

## Bumping `capsule_schema_version`

When the local Gene Map adds a semantic field that the registry should learn
to read (context vectors, signed provenance, etc.):

1. Bump `GeneMap.CAPSULE_SCHEMA_VERSION` in `packages/gene-map/src/gene-map.ts`.
2. Add the new field to the migration **as a new migration file** (`0002_*.sql`),
   not by editing `0001_gene_registry.sql`.
3. Update POST handler to accept and store the new field.
4. Old SDK versions still write `capsule_schema_version: 1` rows safely; new
   readers branch on the version column.
