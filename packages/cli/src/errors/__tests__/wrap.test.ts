import { wrapGitHubCall, wrapClaudeCall } from '../wrap';
import { HelixError, ErrorCategory } from '../index';

function makeError(props: Record<string, unknown>): Error {
  const e = new Error(String(props.message ?? 'mock error'));
  return Object.assign(e, props);
}

describe('wrapGitHubCall', () => {
  it('translates 401 → AUTH_TOKEN_EXPIRED', async () => {
    await expect(wrapGitHubCall(async () => { throw makeError({ status: 401 }); }))
      .rejects.toMatchObject({ category: ErrorCategory.AUTH_TOKEN_EXPIRED });
  });

  it('translates 403 + rate-limit message → GITHUB_RATE_LIMITED', async () => {
    await expect(wrapGitHubCall(async () => {
      throw makeError({
        status: 403,
        message: 'API rate limit exceeded for user',
        response: { headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) } },
      });
    })).rejects.toMatchObject({ category: ErrorCategory.GITHUB_RATE_LIMITED, retryable: true });
  });

  it('translates 404 → GITHUB_REPO_NOT_FOUND', async () => {
    await expect(wrapGitHubCall(async () => {
      throw makeError({ status: 404, request: { url: '/repos/x/y' } });
    })).rejects.toMatchObject({ category: ErrorCategory.GITHUB_REPO_NOT_FOUND });
  });

  it('translates ENOTFOUND → NETWORK_OFFLINE', async () => {
    await expect(wrapGitHubCall(async () => { throw makeError({ code: 'ENOTFOUND' }); }))
      .rejects.toMatchObject({ category: ErrorCategory.NETWORK_OFFLINE, retryable: true });
  });

  it('passes through unknown errors untouched', async () => {
    const orig = new Error('strange error');
    await expect(wrapGitHubCall(async () => { throw orig; })).rejects.toBe(orig);
  });
});

describe('wrapClaudeCall', () => {
  it('translates 429 → CLAUDE_RATE_LIMITED', async () => {
    await expect(wrapClaudeCall(async () => {
      throw makeError({ status: 429, headers: { 'retry-after': '30' } });
    })).rejects.toMatchObject({ category: ErrorCategory.CLAUDE_RATE_LIMITED, retryable: true });
  });

  it('translates 529 → CLAUDE_OVERLOADED', async () => {
    await expect(wrapClaudeCall(async () => { throw makeError({ status: 529 }); }))
      .rejects.toMatchObject({ category: ErrorCategory.CLAUDE_OVERLOADED, retryable: true });
  });

  it('translates 401 → CLAUDE_NO_API_KEY', async () => {
    await expect(wrapClaudeCall(async () => { throw makeError({ status: 401 }); }))
      .rejects.toMatchObject({ category: ErrorCategory.CLAUDE_NO_API_KEY });
  });

  it('translates ETIMEDOUT → NETWORK_TIMEOUT', async () => {
    await expect(wrapClaudeCall(async () => { throw makeError({ code: 'ETIMEDOUT' }); }))
      .rejects.toMatchObject({ category: ErrorCategory.NETWORK_TIMEOUT });
  });
});
