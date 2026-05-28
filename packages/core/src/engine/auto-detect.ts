/**
 * Auto-Detect — Identifies function signatures and applies repair overrides automatically.
 * Removes the need for users to write parameterModifier.
 */

export type AmountShape = 'number' | 'numeric-string' | 'string' | 'array' | 'object' | 'undefined';

export interface DetectedSignature {
  type: 'viem-tx' | 'fetch' | 'generic-payment' | 'unknown';
  paramIndex: number;
  /**
   * Shape of the payment amount field, when detectable. Determines whether a
   * strategy may safely apply scalar arithmetic (halve, split) to it. Only
   * 'number' and 'numeric-string' are safe; arrays/objects/ambiguous strings
   * are NOT (e.g. Circle's `amount: string[]`). Optional for backward-compat
   * with callers that construct DetectedSignature directly; detectSignature
   * always populates it.
   */
  amountShape?: AmountShape;
}

/**
 * Classify a payment amount's shape. Only 'number' / 'numeric-string' (and
 * bigint, treated as 'number') are safe for scalar math. Arrays (Circle's
 * `amount: string[]`), objects ({ value, currency }), and non-numeric strings
 * MUST NOT be scalar-mutated — doing so corrupts the shape the SDK requires
 * and turns a recoverable error into a self-inflicted invalid-param failure.
 */
export function amountShapeOf(v: unknown): AmountShape {
  if (v === undefined || v === null) return 'undefined';
  if (typeof v === 'number' || typeof v === 'bigint') return 'number';
  if (typeof v === 'string') {
    const t = v.trim();
    return t !== '' && Number.isFinite(Number(t)) ? 'numeric-string' : 'string';
  }
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return 'string';
}

export function detectSignature(args: unknown[]): DetectedSignature {
  if (!args || args.length === 0) return { type: 'unknown', paramIndex: -1, amountShape: 'undefined' };
  const first = args[0] as Record<string, unknown>;

  // Viem transaction: has 'to' + at least one other tx field
  if (typeof first === 'object' && first !== null && 'to' in first) {
    const txFields = ['to', 'value', 'nonce', 'gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'data', 'chainId'];
    if (txFields.filter(f => f in first).length >= 2) return { type: 'viem-tx', paramIndex: 0, amountShape: amountShapeOf(first.value) };
  }

  // Fetch-like: first arg is URL string
  if (typeof first === 'string' && (first as string).startsWith('http')) return { type: 'fetch', paramIndex: 0, amountShape: 'undefined' };

  // Generic payment object
  if (typeof first === 'object' && first !== null && ('amount' in first || 'value' in first)) {
    return { type: 'generic-payment', paramIndex: 0, amountShape: amountShapeOf(first.amount ?? first.value) };
  }

  return { type: 'unknown', paramIndex: -1, amountShape: 'undefined' };
}

export function applyOverrides(args: unknown[], overrides: Record<string, unknown>, strategy: string, sig: DetectedSignature): unknown[] | null {
  if (sig.type === 'unknown') return null;
  // Allow strategies that modify params even without explicit overrides
  const alwaysApply = ['reduce_request', 'speed_up_transaction', 'refresh_nonce', 'remove_and_resubmit'];
  if (Object.keys(overrides).length === 0 && !alwaysApply.includes(strategy)) return null;
  const newArgs = [...args];

  if (sig.type === 'viem-tx') {
    const tx = { ...(newArgs[0] as Record<string, unknown>) };
    switch (strategy) {
      case 'refresh_nonce':
        if (overrides.nonce !== undefined) tx.nonce = overrides.nonce;
        else delete tx.nonce; // remove wrong nonce, let viem auto-assign
        break;
      case 'reduce_request':
        if (overrides.amount !== undefined) tx.value = BigInt(overrides.amount as string);
        else if (tx.value) tx.value = BigInt(tx.value as bigint) / 2n;
        break;
      case 'speed_up_transaction':
        if (overrides.gasPrice !== undefined) tx.gasPrice = BigInt(overrides.gasPrice as string);
        else if (tx.gasPrice) tx.gasPrice = (BigInt(tx.gasPrice as bigint) * 130n) / 100n;
        else if (tx.maxFeePerGas) tx.maxFeePerGas = (BigInt(tx.maxFeePerGas as bigint) * 130n) / 100n;
        // If gas limit is explicitly set too low, remove it to let the client auto-estimate
        if (tx.gas && BigInt(tx.gas as bigint) < 21000n) delete tx.gas;
        break;
      case 'switch_network':
        if (overrides.chainId !== undefined) tx.chainId = overrides.chainId;
        break;
      case 'remove_and_resubmit':
        delete tx.nonce;
        if (tx.gasPrice) tx.gasPrice = (BigInt(tx.gasPrice as bigint) * 130n) / 100n;
        if (tx.maxFeePerGas) tx.maxFeePerGas = (BigInt(tx.maxFeePerGas as bigint) * 130n) / 100n;
        if (tx.maxPriorityFeePerGas) tx.maxPriorityFeePerGas = (BigInt(tx.maxPriorityFeePerGas as bigint) * 150n) / 100n;
        break;
      case 'renew_session':
        if (overrides.authorization) tx.authorization = overrides.authorization;
        if (overrides.sessionToken) tx.sessionToken = overrides.sessionToken;
        break;
      case 'fix_params':
        Object.assign(tx, overrides);
        break;
      default:
        for (const [k, v] of Object.entries(overrides)) { if (k in tx) tx[k] = v; }
    }
    newArgs[0] = tx;
    return newArgs;
  }

  if (sig.type === 'fetch') {
    if (strategy === 'switch_endpoint' && overrides.url) newArgs[0] = overrides.url;
    return newArgs;
  }

  if (sig.type === 'generic-payment') {
    const p = { ...(newArgs[0] as Record<string, unknown>) };
    const shape = sig.amountShape ?? amountShapeOf(p.amount);

    // L1 guard: the generic-payment path only understands SCALAR numeric
    // amounts. If the amount is an array (e.g. Circle's `amount: string[]`),
    // an object, or an ambiguous non-numeric string, REFUSE to mutate it —
    // scaling or replacing it would corrupt the shape the SDK requires and
    // self-inflict an invalid-param failure. Returning null makes wrap()
    // retry with the original args / surface the real error unchanged.
    if (shape === 'array' || shape === 'object' || shape === 'string') {
      return null;
    }

    if (strategy === 'reduce_request') {
      if (overrides.amount !== undefined) p.amount = overrides.amount;
      else if (shape === 'number') p.amount = (p.amount as number) * 0.5;
      // numeric-string: halve but round-trip back to a string so the shape
      // the SDK received (a scalar string) is preserved.
      else if (shape === 'numeric-string') p.amount = String(Number(p.amount) * 0.5);
    } else {
      for (const [k, v] of Object.entries(overrides)) { if (k in p) p[k] = v; }
    }
    newArgs[0] = p;
    return newArgs;
  }

  return null;
}
