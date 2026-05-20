import { HelixError, ErrorCategory } from './index';

export const errors = {
  envNodeTooOld(actual: string, required: string) {
    return new HelixError({
      category: ErrorCategory.ENV_NODE_TOO_OLD,
      message: `Node.js ${required}+ required, you have ${actual}`,
      remediation: [
        `Install Node.js ${required} or later: https://nodejs.org`,
        `Or use nvm:  nvm install ${required.split('.')[0]}`,
      ],
    });
  },

  envNotGitRepo(cwd: string) {
    return new HelixError({
      category: ErrorCategory.ENV_NOT_GIT_REPO,
      message: `${cwd} is not a git repository`,
      remediation: [
        `cd into a git repo, or:`,
        `git init && git remote add origin <your-repo-url>`,
      ],
    });
  },

  authNoToken() {
    return new HelixError({
      category: ErrorCategory.AUTH_NO_TOKEN,
      message: 'GitHub authentication required',
      remediation: [
        'Run:  vial auth login',
        'Or set GITHUB_TOKEN env var with repo + read:user scopes',
      ],
      docsUrl: 'https://helix.dev/docs/install#auth',
    });
  },

  authTokenExpired() {
    return new HelixError({
      category: ErrorCategory.AUTH_TOKEN_EXPIRED,
      message: 'Your GitHub token has expired',
      remediation: ['Re-authenticate:  vial auth login'],
    });
  },

  authInsufficientScope(missing: string[]) {
    return new HelixError({
      category: ErrorCategory.AUTH_INSUFFICIENT_SCOPE,
      message: `GitHub token missing scopes: ${missing.join(', ')}`,
      remediation: [
        'Re-authenticate with required scopes:',
        '  vial auth login --scopes repo,read:user',
      ],
    });
  },

  networkOffline(target: string) {
    return new HelixError({
      category: ErrorCategory.NETWORK_OFFLINE,
      message: `Can't reach ${target} — check your internet connection`,
      remediation: ['Check your network connection', 'Try again in a moment'],
      retryable: true,
    });
  },

  networkTimeout(target: string, timeoutMs: number) {
    return new HelixError({
      category: ErrorCategory.NETWORK_TIMEOUT,
      message: `Request to ${target} timed out after ${timeoutMs}ms`,
      remediation: ['Retry the command', 'If this persists, check if the service is up'],
      retryable: true,
    });
  },

  githubRateLimited(resetAt: Date) {
    const minutes = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 60000));
    return new HelixError({
      category: ErrorCategory.GITHUB_RATE_LIMITED,
      message: `GitHub API rate limited (resets in ${minutes}m)`,
      remediation: [
        `Wait ${minutes} minutes and retry`,
        'Or authenticate with a PAT for higher limits:  vial auth login',
      ],
      retryable: true,
    });
  },

  githubRepoNotFound(repo: string) {
    return new HelixError({
      category: ErrorCategory.GITHUB_REPO_NOT_FOUND,
      message: `Repository ${repo} not found or you don't have access`,
      remediation: [
        'Check the repo name (case-sensitive)',
        `If it's a private repo, ensure your token has access`,
        `Try:  gh repo view ${repo}`,
      ],
    });
  },

  githubPushDenied(branch: string, repo: string) {
    return new HelixError({
      category: ErrorCategory.GITHUB_PUSH_DENIED,
      message: `Can't push branch '${branch}' to ${repo}`,
      remediation: [
        'You may not have write access to this repo',
        'Helix needs to push to a branch to open a PR',
        `For repos you don't own, fork first:  gh repo fork ${repo}`,
      ],
      docsUrl: 'https://helix.dev/docs/cli#vial-run',
    });
  },

  githubPRCreateFailed(reason: string, branch: string, repo: string) {
    return new HelixError({
      category: ErrorCategory.GITHUB_PR_CREATE_FAILED,
      message: `Failed to create PR: ${reason}`,
      remediation: [
        `Your fix has been pushed to branch '${branch}'`,
        'You can open the PR manually:',
        `  gh pr create --repo ${repo} --head ${branch}`,
        'Or via GitHub web UI.',
      ],
    });
  },

  claudeRateLimited(retryAfterSec?: number) {
    const wait = retryAfterSec ? `${retryAfterSec}s` : 'a moment';
    return new HelixError({
      category: ErrorCategory.CLAUDE_RATE_LIMITED,
      message: `Anthropic API rate limited`,
      remediation: [
        `Wait ${wait} and retry`,
        'If this happens often, consider upgrading your Anthropic plan',
      ],
      retryable: true,
    });
  },

  claudeOverloaded() {
    return new HelixError({
      category: ErrorCategory.CLAUDE_OVERLOADED,
      message: 'Anthropic API is currently overloaded',
      remediation: ['Wait 30s and retry', 'Status: https://status.anthropic.com'],
      retryable: true,
    });
  },

  claudeNoApiKey() {
    return new HelixError({
      category: ErrorCategory.CLAUDE_NO_API_KEY,
      message: 'Anthropic API key not configured',
      remediation: [
        'Set ANTHROPIC_API_KEY in your environment',
        'Or run:  vial config set anthropic-key <your-key>',
        'Get a key:  https://console.anthropic.com/settings/keys',
      ],
    });
  },

  claudeInvalidResponse(detail: string) {
    return new HelixError({
      category: ErrorCategory.CLAUDE_INVALID_RESPONSE,
      message: `Got unexpected response from Claude: ${detail}`,
      remediation: ['Retry the command', 'If it persists, this may be a Helix bug'],
      retryable: true,
    });
  },

  testsFailed(testCommand: string, failures: number) {
    return new HelixError({
      category: ErrorCategory.TESTS_FAILED,
      message: `Tests failed after fix (${failures} failures)`,
      remediation: [
        `Fix was generated but tests didn't pass — NOT pushing.`,
        `The diff has been saved to .helix/last-diff.patch`,
        'Review the diff and apply manually if it looks right:',
        `  git apply .helix/last-diff.patch`,
        `Or rerun with:  vial run --skip-tests`,
      ],
    });
  },

  noDiffProduced() {
    return new HelixError({
      category: ErrorCategory.NO_DIFF_PRODUCED,
      message: 'Claude completed but produced no code changes',
      remediation: [
        `This usually means the issue isn't clear enough to act on`,
        'Try:  vial triage --explain <#issue>  to see why',
        'Or add more context to the issue description and rerun',
      ],
    });
  },

  issueNotActionable(issueRef: string, score: number) {
    return new HelixError({
      category: ErrorCategory.ISSUE_NOT_ACTIONABLE,
      message: `Issue ${issueRef} is not actionable (score: ${score}/100)`,
      remediation: [
        `Run:  vial triage --explain ${issueRef}  to see why`,
        `Or force-run with:  vial run ${issueRef} --force`,
      ],
    });
  },

  geneMapCorrupt(reason: string) {
    return new HelixError({
      category: ErrorCategory.GENE_MAP_CORRUPT,
      message: `Gene Map database appears corrupt: ${reason}`,
      remediation: [
        'Back up and rebuild:',
        '  mv ~/.helix/gene-map.db ~/.helix/gene-map.db.bak',
        '  vial init',
        `You'll lose learned capsules but won't lose any code.`,
      ],
    });
  },
};
