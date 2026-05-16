# seller-bench

Stateless Cloudflare Worker that simulates an x402 seller for the Circle × Helix
benchmark. Three endpoints, configurable failure injection.

## Endpoints

### `GET /health`
Returns `{ "status": "ok", "version": "v0.1" }`.

### `GET /service?id=<n>&fail_rate=<0..1>&ttl_ms=<int>`
- With probability `fail_rate` (default `0.05`): returns `503` with
  `{ "error": "service unavailable" }`. This is the **unpreventable / random**
  failure class — used as a control group.
- Otherwise returns `200` with:
  ```json
  {
    "service_id": <n>,
    "price_usdc": "0.001",
    "quote_id": "<uuid>",
    "deliverable_url": "/deliverable/<n>",
    "expires_at": "<ISO timestamp, now + ttl_ms>"
  }
  ```
  - `ttl_ms` is optional, defaults to `8000` (8 seconds), capped at `3600000`
    (1 hour). Use a large value (e.g. `300000`) for timing measurement so
    quotes don't go stale during the run. The default 8s TTL makes
    `stale_quote` a real structural failure class.

### `POST /verify`
Body:
```json
{
  "tx_id": "<string>",
  "service_id": <number>,
  "quote_expires_at": "<ISO timestamp from /service response>",
  "fail_rate": 0.05
}
```
Resolution order:
1. `tx_id` missing/empty → `{ "delivered": false, "reason": "invalid_tx" }`
2. `quote_expires_at` missing or unparseable →
   `{ "delivered": false, "reason": "missing_quote_expiry" }`
3. `Date.now() > Date.parse(quote_expires_at)` →
   `{ "delivered": false, "reason": "stale_quote" }` (deterministic — time-based)
4. Otherwise → `{ "delivered": true, "deliverable": "content-<service_id>" }`

**`stale_quote` is deterministic, not random** — same timing produces same
outcome. `fail_rate` is accepted in the body for backward compat but no longer
triggers any random injection on `/verify`.

CORS is wide open (`Access-Control-Allow-Origin: *`). Every request is logged via
`console.log` so you can stream them with `wrangler tail`.

## Deploy

```bash
cd scripts/circle-bench/seller
npm install
npx wrangler login           # one-time, if not already authed
npm run deploy               # or: npx wrangler deploy
```

Capture the deployed URL from wrangler's output. Set it as `SELLER_URL` in
`scripts/circle-bench/.env`.

## Smoke tests

Replace `<URL>` with the deployed Worker URL (e.g. `https://seller-bench.<account>.workers.dev`).

```bash
# Health
curl "<URL>/health"
# -> {"status":"ok","version":"v0.1"}

# Successful service quote
curl "<URL>/service?id=1"

# Forced failure (fail_rate=1.0)
curl -i "<URL>/service?id=1&fail_rate=1.0"
# -> HTTP/1.1 503 with {"error":"service unavailable"}

# Quote NOT expired -> delivered:true
curl -X POST "<URL>/verify" \
  -H "content-type: application/json" \
  -d '{"tx_id":"test-tx","service_id":1,"quote_expires_at":"2099-01-01T00:00:00.000Z"}'
# -> {"delivered":true,"deliverable":"content-1"}

# Quote expired -> stale_quote (deterministic, time-based)
curl -X POST "<URL>/verify" \
  -H "content-type: application/json" \
  -d '{"tx_id":"test-tx","service_id":1,"quote_expires_at":"2020-01-01T00:00:00.000Z"}'
# -> {"delivered":false,"reason":"stale_quote"}

# Missing quote_expires_at -> missing_quote_expiry
curl -X POST "<URL>/verify" \
  -H "content-type: application/json" \
  -d '{"tx_id":"test-tx","service_id":1}'
# -> {"delivered":false,"reason":"missing_quote_expiry"}

# Empty tx_id -> invalid_tx (takes precedence)
curl -X POST "<URL>/verify" \
  -H "content-type: application/json" \
  -d '{"tx_id":"","service_id":1,"quote_expires_at":"2099-01-01T00:00:00.000Z"}'
# -> {"delivered":false,"reason":"invalid_tx"}
```

## Live logs

```bash
npm run tail   # or: npx wrangler tail seller-bench
```

## Local dev (optional)

If Cloudflare deploy is unavailable, run locally:

```bash
npm run dev    # binds to http://localhost:8787
```

Pair with `ngrok http 8787` to expose externally.
