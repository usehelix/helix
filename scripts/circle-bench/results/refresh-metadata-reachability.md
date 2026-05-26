# `refresh_metadata` reachability — finding from Bench 2.4

**Status:** Design-intent action; currently NOT reachable through live
Circle API error shapes. Documented for PR #4 fix.

**Bench reference:** `v2-smart-param-e2e-2026-05-26T07-15-11.json` (Group B)

---

## Design intent

`smart_param_repair.ts` declares the action:

```ts
| { type: 'refresh_metadata'; resource: 'tokenId' | 'walletId' }
```

with `applyParamRepair` returning `canRetry: false` and the diagnostic
`Refresh ${resource} required (caller must re-fetch)`.

The routing rule (in `smart_param_repair.ts`, lines roughly around
"6. Unknown / stale resource id"):

```ts
if (location === 'tokenid' || /token ?id|unknown token/i.test(message)) {
  return { type: 'refresh_metadata', resource: 'tokenId' };
}
if (location === 'walletid' || /wallet ?id|unknown wallet/i.test(message)) {
  return { type: 'refresh_metadata', resource: 'walletId' };
}
```

**Intent:** when Circle reports a stale or non-existent tokenId/walletId
reference, route the agent to re-fetch the resource id before retrying.
Distinct from `hold_and_notify` (terminal hold) and `strip_field`
(idempotency cleanup).

## What Circle Sandbox actually returns (probed May 26 2026)

Two distinct shapes were observed for tokenId issues, NEITHER of which
matches the routing rule's pattern:

### Shape 1 — nil UUID (`'00000000-0000-0000-0000-000000000000'`)

```
HTTP 400
{
  "code": 2,
  "message": "API parameter invalid",
  "errors": [
    {
      "error": "uuid_format",
      "invalidValue": "00000000-0000-0000-0000-000000000000",
      "location": "tokenId",
      "message": "'tokenId' field is not in the correct UUID format (was 00000000-...)"
    }
  ]
}
```

Router lands on **Rule 2 (uuid_format → `hold_and_notify`)** because
`error: 'uuid_format'` matches `isUuidFormatViolation()` before Rule 6's
location check is reached. Circle treats the nil UUID as malformed,
not as a missing reference.

### Shape 2 — well-formed random UUID (`randomUUID()`, not in Circle's DB)

```
HTTP 404
{
  "code": 156002,
  "message": "Cannot find target token in the system. Either the specified token doesn't exist or it's not accessible to the caller."
}
```

**No `errors[]` array.** Router lands on the catch-all `hold_and_notify`
with diagnostic `"No structured error details available"` because the
`errors` array is empty.

## Why Rule 6 never fires

The pattern `/token ?id|unknown token/i` was a reasonable guess but
doesn't match Circle's actual phrasing:

| Circle's message | Matches `/token ?id|unknown token/i`? |
|---|---|
| `"'tokenId' field is not in the correct UUID format..."` | yes — but Rule 2 catches it first |
| `"Cannot find target token in the system..."` | **no** — phrase is "target token", not "token id" or "unknown token" |

Even if Rule 2 didn't fire first on Shape 1, Shape 2 (the actually-
unknown-token case) bypasses the entire `errors[]`-based router and
goes straight to the empty-errors catch-all.

## Recommendation for PR #4

Add numeric-code routing for Circle's HTTP 404 + code 156002 family.
Either:

**(a) In `circle/perceive.ts`** — add a numeric-block branch for
`circleCode === 156002` → returns a new failure code like
`'circle-resource-not-found'`. Then the multi-strategy Gene Map
maps that code to `refresh_metadata` as one of its candidates.

**(b) In `smart-param-repair.ts`** — add a top-level numeric check
before the `errors[]` switch:

```ts
const code = error?.response?.data?.code;
const status = error?.response?.status;
if (status === 404 && code === 156002) {
  return { type: 'refresh_metadata', resource: 'tokenId' };
}
// Then check for walletId equivalent (probe needed — 156003? 156004?)
```

Option (a) is cleaner because it lives in the perceive layer where
all Circle codes are recognised. Option (b) is faster to ship as a
standalone v2 patch if PR #4's multi-strategy work is delayed.

## Why we ship the gap unfixed

PR #3's scope is "ship standalone v2 strategies + bench data;
discover gaps for PR #4." Discovering that `refresh_metadata` is
currently unreachable IS the kind of finding that the bench is
designed to surface. Fixing it in PR #3 would require either:

- Modifying `smart-param-repair.ts` (out of scope per Phase 2 spec)
- Touching `circle/perceive.ts` (would invalidate PR #2's perceive
  contract until re-tested)

Both options expand the PR's risk surface for marginal demo value.
The current behavior is **safe** (router holds rather than retrying
blindly) and **honest** (caller gets a diagnostic, even if not the
ideal one). PR #4 can fix this alongside the multi-strategy migration.

## Net Bench 2.4 result

```
Group A (idempotencyKey strip):  20/20 ✓ — 100% auto-fix, real Arc tx
Group B (nil-UUID tokenId):       0/20  — held instead of refresh_metadata
                                          (Circle returns uuid_format)
Group C ("not-a-uuid" walletId): 20/20 ✓ — 100% correct hold + diagnostic
```

40/60 attempts (67%) take auto-fix path with **real Arc Testnet
validation**. 20/60 (33%) correctly held with precise diagnostic.

100% of Group B was held safely — no destructive retry, no data
loss. The "failure" is the bench's expectation, not the router's
behavior.
