import { withRetry } from '../retry';
import { HelixError, ErrorCategory } from '../index';

describe('withRetry', () => {
  it('retries a retryable HelixError until success', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) {
        throw new HelixError({
          category: ErrorCategory.CLAUDE_OVERLOADED,
          message: 'overloaded',
          remediation: [],
          retryable: true,
        });
      }
      return 'ok';
    }, { maxAttempts: 3, initialDelayMs: 1 });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry a non-retryable HelixError', async () => {
    let attempts = 0;
    const promise = withRetry(async () => {
      attempts++;
      throw new HelixError({
        category: ErrorCategory.AUTH_NO_TOKEN,
        message: 'no token',
        remediation: [],
        retryable: false,
      });
    }, { maxAttempts: 5, initialDelayMs: 1 });
    await expect(promise).rejects.toMatchObject({ category: ErrorCategory.AUTH_NO_TOKEN });
    expect(attempts).toBe(1);
  });

  it('does not retry plain Error (only retryable HelixErrors)', async () => {
    let attempts = 0;
    const promise = withRetry(async () => {
      attempts++;
      throw new Error('weird');
    }, { maxAttempts: 5, initialDelayMs: 1 });
    await expect(promise).rejects.toThrow('weird');
    expect(attempts).toBe(1);
  });

  it('throws the last error after exhausting maxAttempts on retryable error', async () => {
    let attempts = 0;
    const promise = withRetry(async () => {
      attempts++;
      throw new HelixError({
        category: ErrorCategory.NETWORK_TIMEOUT,
        message: `attempt ${attempts}`,
        remediation: [],
        retryable: true,
      });
    }, { maxAttempts: 3, initialDelayMs: 1 });
    await expect(promise).rejects.toMatchObject({ message: 'attempt 3' });
    expect(attempts).toBe(3);
  });

  it('calls onRetry with attempt + delay before retrying', async () => {
    const onRetry = jest.fn();
    let attempts = 0;
    await withRetry(async () => {
      attempts++;
      if (attempts < 2) {
        throw new HelixError({
          category: ErrorCategory.CLAUDE_RATE_LIMITED,
          message: 'r',
          remediation: [],
          retryable: true,
        });
      }
      return 1;
    }, { maxAttempts: 3, initialDelayMs: 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(HelixError), expect.any(Number));
  });
});
