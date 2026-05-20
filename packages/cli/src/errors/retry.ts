import { HelixError } from './index';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, err: HelixError, delayMs: number) => void;
}

/**
 * Retry a function whose thrown HelixError has `retryable=true`.
 * Non-retryable HelixErrors and plain Errors are re-thrown immediately.
 * Backoff is exponential, capped at maxDelayMs.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const max = opts.maxAttempts ?? 3;
  const initial = opts.initialDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 30000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof HelixError) || !err.retryable || attempt === max) throw err;
      const delay = Math.min(initial * Math.pow(2, attempt - 1), cap);
      opts.onRetry?.(attempt, err, delay);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
