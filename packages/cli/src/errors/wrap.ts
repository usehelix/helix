import { errors } from './factories';

/**
 * Wrap a GitHub API call (Octokit or fetch-based) so raw errors get translated
 * into HelixError with remediation. Unknown errors are re-thrown untouched so
 * the top-level handler still sees them.
 */
export async function wrapGitHubCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (err?.status === 401) throw errors.authTokenExpired();
    if (err?.status === 403 && typeof err.message === 'string' && err.message.includes('rate limit')) {
      const resetTime = err?.response?.headers?.['x-ratelimit-reset'];
      const resetAt = resetTime ? new Date(Number(resetTime) * 1000) : new Date(Date.now() + 60_000);
      throw errors.githubRateLimited(resetAt);
    }
    if (err?.status === 404) {
      throw errors.githubRepoNotFound(err?.request?.url ?? 'unknown');
    }
    if (err?.status === 422 && typeof err.message === 'string' && err.message.includes('pull request')) {
      throw errors.githubPRCreateFailed(err.message, '?', '?');
    }
    if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED') {
      throw errors.networkOffline('api.github.com');
    }
    if (err?.code === 'ETIMEDOUT') {
      throw errors.networkTimeout('api.github.com', 10000);
    }
    throw err;
  }
}

export async function wrapClaudeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (err?.status === 429) {
      const retryAfter = err?.headers?.['retry-after'];
      throw errors.claudeRateLimited(retryAfter ? Number(retryAfter) : undefined);
    }
    if (err?.status === 529 || err?.status === 503) throw errors.claudeOverloaded();
    if (err?.status === 401) throw errors.claudeNoApiKey();
    if (typeof err?.message === 'string' && err.message.includes('invalid JSON')) {
      throw errors.claudeInvalidResponse('Response was not valid JSON');
    }
    if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED') {
      throw errors.networkOffline('api.anthropic.com');
    }
    if (err?.code === 'ETIMEDOUT') {
      throw errors.networkTimeout('api.anthropic.com', 60000);
    }
    throw err;
  }
}
