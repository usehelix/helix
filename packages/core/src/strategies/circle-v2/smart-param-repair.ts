/**
 * @file smart-param-repair.ts
 * @description v2 strategy for `circle-param-invalid` (Circle Web SDK code 2).
 *
 * v1 routes EVERY param error to `hold_and_notify` — 0% auto-fix rate. This
 * v2 router inspects `error.response.data.errors[]` and picks one of six
 * structured actions:
 *
 *   strip_field         — drop a field that Circle rejects (e.g. idempotencyKey
 *                          on Arc Sandbox, where the API rejects despite the
 *                          SDK type declaring it valid)
 *   coerce_type         — fix string/array/number type mismatches
 *   normalize_address   — fix 0x-prefix / case issues on hex addresses
 *   inject_default      — supply a missing required field (e.g. fee)
 *   refresh_metadata    — caller must re-fetch tokenId / walletId
 *   hold_and_notify     — catch-all matching v1 behaviour
 *
 * Two-function API:
 *   - smartParamRepair(error)  — pure routing decision
 *   - applyParamRepair(args, action) — mutates the call args (deep clone)
 *
 * STANDALONE — not integrated into the PCEC engine. Bench scripts compare
 * this against v1 `hold_and_notify` on identical Circle Sandbox error inputs.
 */

// ──────────────────────────────────────────────────────────────────────
// Error shape — matches Circle Wallets API observed in PR #2 probes.
// ──────────────────────────────────────────────────────────────────────

/**
 * Structured Circle parameter error.
 *
 * Real shape from `scripts/circle-bench/probe-error-shapes.ts` (SDK v10):
 *   {
 *     response: {
 *       data: {
 *         code: 2,
 *         message: "API parameter invalid",
 *         errors: [{
 *           error: "uuid_format",                  // ← actual key
 *           invalidValue: "deliberate-probe-bad-key",
 *           location: "idempotencyKey",
 *           message: "'idempotencyKey' field is not in the correct UUID format..."
 *         }]
 *       }
 *     }
 *   }
 *
 * The spec used `constraint` for the type-tag field; the live SDK uses
 * `error`. Accept both so we don't paper over the variant we haven't seen.
 */
export interface CircleParamErrorEntry {
  /** Type tag from Circle (SDK v10 uses "error"; earlier docs say "constraint"). */
  error?: string;
  /** Alternative type tag name; checked alongside `error`. */
  constraint?: string;
  /** Path or field name where the violation occurred. */
  location?: string;
  /** Value that was rejected (for diagnostics). */
  invalidValue?: unknown;
  /** Human-readable violation description. */
  message?: string;
}

export interface CircleParamError {
  response?: {
    data?: {
      code?: number;
      message?: string;
      errors?: CircleParamErrorEntry[];
    };
  };
}

// ──────────────────────────────────────────────────────────────────────
// Repair action union (discriminated; switch in applyParamRepair is exhaustive)
// ──────────────────────────────────────────────────────────────────────

export type ParamRepairAction =
  | { type: 'strip_field'; field: string }
  | { type: 'coerce_type'; field: string; toType: 'string' | 'number' | 'array' }
  | { type: 'normalize_address'; field: string }
  | { type: 'inject_default'; field: string; value: unknown }
  | { type: 'refresh_metadata'; resource: 'tokenId' | 'walletId' }
  | { type: 'hold_and_notify'; diagnostic: string };

// ──────────────────────────────────────────────────────────────────────
// Routing — pure function from error shape to action
// ──────────────────────────────────────────────────────────────────────

function isUuidFormatViolation(entry: CircleParamErrorEntry, message: string): boolean {
  return (
    entry.error === 'uuid_format'
    || entry.constraint === 'uuid_format'
    || /uuid/i.test(message)
  );
}

export function smartParamRepair(error: CircleParamError): ParamRepairAction {
  const errors = error?.response?.data?.errors ?? [];
  const first = errors[0];
  if (!first) {
    return { type: 'hold_and_notify', diagnostic: 'No structured error details available' };
  }

  const location = String(first.location ?? '').toLowerCase();
  const message = String(first.message ?? '').toLowerCase();
  const rawLocation = first.location ?? '(unknown)';

  // 1. idempotencyKey rejection — strip and retry.
  //    Verified in PR #2 probe: Arc Sandbox rejects this field even though
  //    SDK v10 declares it valid.
  if (location === 'idempotencykey' || /idempotency/i.test(message)) {
    return { type: 'strip_field', field: 'idempotencyKey' };
  }

  // 2. UUID format violation on a non-idempotency field — caller must fix.
  //    walletId / tokenId / etc. that aren't valid UUIDs can't be repaired
  //    automatically — only the caller knows the correct value.
  if (isUuidFormatViolation(first, message)) {
    return {
      type: 'hold_and_notify',
      diagnostic: `Invalid UUID format in ${rawLocation}; caller must supply a valid UUID`,
    };
  }

  // 3. Amount type mismatch — coerce to the expected type.
  if (location === 'amount' || location === 'amounts') {
    if (/must be (a )?string|expected string/i.test(message)) {
      return { type: 'coerce_type', field: rawLocation, toType: 'string' };
    }
    if (/must be (an )?array|expected array/i.test(message)) {
      return { type: 'coerce_type', field: rawLocation, toType: 'array' };
    }
    if (/must be (a )?number|expected number/i.test(message)) {
      return { type: 'coerce_type', field: rawLocation, toType: 'number' };
    }
  }

  // 4. Address format errors — normalize 0x prefix + case.
  if (location.includes('address') || location === 'destinationaddress') {
    if (/hex|format|invalid|0x|checksum/i.test(message)) {
      return { type: 'normalize_address', field: rawLocation };
    }
  }

  // 5. Missing fee — inject a sensible default.
  if (location === 'fee' || /missing.*fee|fee.*required/i.test(message)) {
    return {
      type: 'inject_default',
      field: 'fee',
      value: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    };
  }

  // 6. Unknown / stale resource id — caller must re-fetch.
  if (location === 'tokenid' || /token ?id|unknown token/i.test(message)) {
    return { type: 'refresh_metadata', resource: 'tokenId' };
  }
  if (location === 'walletid' || /wallet ?id|unknown wallet/i.test(message)) {
    return { type: 'refresh_metadata', resource: 'walletId' };
  }

  // 7. Catch-all — preserve v1 semantics.
  return {
    type: 'hold_and_notify',
    diagnostic: `${rawLocation}: ${first.message ?? '(no message)'}`,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Application — mutates a deep clone of args per the action
// ──────────────────────────────────────────────────────────────────────

export interface ApplyParamRepairResult<TArgs = Record<string, unknown>> {
  args: TArgs;
  /** Whether the caller should retry with these new args. */
  canRetry: boolean;
  /** Human-readable description of what was applied. */
  description: string;
}

/**
 * Mutate a deep clone of `args` according to `action`. The original `args`
 * is never mutated.
 *
 * Deep clone is `structuredClone` if available (Node 17+); otherwise falls
 * back to JSON round-trip — adequate for plain JSON request bodies (which
 * Circle's createTransaction args are). Date/Map/etc. won't survive the
 * JSON path; if a caller needs those, switch to structuredClone explicitly.
 */
export function applyParamRepair<TArgs extends Record<string, unknown>>(
  args: TArgs,
  action: ParamRepairAction,
): ApplyParamRepairResult<TArgs> {
  const cloned = (typeof structuredClone === 'function'
    ? structuredClone(args)
    : JSON.parse(JSON.stringify(args))) as TArgs;
  const newArgs = cloned as Record<string, unknown>;

  switch (action.type) {
    case 'strip_field': {
      delete newArgs[action.field];
      return { args: cloned, canRetry: true, description: `Stripped ${action.field}` };
    }

    case 'coerce_type': {
      const cur = newArgs[action.field];
      if (action.toType === 'string') {
        newArgs[action.field] = String(cur);
      } else if (action.toType === 'array') {
        newArgs[action.field] = Array.isArray(cur) ? cur : [cur];
      } else if (action.toType === 'number') {
        newArgs[action.field] = Number(cur);
      }
      return {
        args: cloned,
        canRetry: true,
        description: `Coerced ${action.field} to ${action.toType}`,
      };
    }

    case 'normalize_address': {
      let addr = String(newArgs[action.field] ?? '');
      if (!addr.startsWith('0x') && !addr.startsWith('0X')) addr = '0x' + addr;
      newArgs[action.field] = addr.toLowerCase();
      return { args: cloned, canRetry: true, description: `Normalized ${action.field}` };
    }

    case 'inject_default': {
      newArgs[action.field] = action.value;
      return { args: cloned, canRetry: true, description: `Injected default ${action.field}` };
    }

    case 'refresh_metadata': {
      // Cannot fix here — caller must re-fetch and retry with a fresh id.
      return {
        args: cloned,
        canRetry: false,
        description: `Refresh ${action.resource} required (caller must re-fetch)`,
      };
    }

    case 'hold_and_notify': {
      return { args: cloned, canRetry: false, description: action.diagnostic };
    }

    default: {
      // Exhaustiveness check — if a new action type is added without a
      // corresponding case, TS will error here.
      const _exhaustive: never = action;
      throw new Error(`Unhandled ParamRepairAction: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
