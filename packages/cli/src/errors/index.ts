export enum ErrorCategory {
  // 用户环境
  ENV_NODE_TOO_OLD = 'env_node_too_old',
  ENV_GIT_NOT_FOUND = 'env_git_not_found',
  ENV_NOT_GIT_REPO = 'env_not_git_repo',

  // 认证
  AUTH_NO_TOKEN = 'auth_no_token',
  AUTH_TOKEN_EXPIRED = 'auth_token_expired',
  AUTH_INSUFFICIENT_SCOPE = 'auth_insufficient_scope',

  // 网络
  NETWORK_TIMEOUT = 'network_timeout',
  NETWORK_DNS_FAILURE = 'network_dns_failure',
  NETWORK_OFFLINE = 'network_offline',

  // GitHub
  GITHUB_RATE_LIMITED = 'github_rate_limited',
  GITHUB_REPO_NOT_FOUND = 'github_repo_not_found',
  GITHUB_FORK_FAILED = 'github_fork_failed',
  GITHUB_PUSH_DENIED = 'github_push_denied',
  GITHUB_PR_CREATE_FAILED = 'github_pr_create_failed',

  // Claude
  CLAUDE_RATE_LIMITED = 'claude_rate_limited',
  CLAUDE_API_DOWN = 'claude_api_down',
  CLAUDE_OVERLOADED = 'claude_overloaded',
  CLAUDE_INVALID_RESPONSE = 'claude_invalid_response',
  CLAUDE_NO_API_KEY = 'claude_no_api_key',

  // 业务
  TESTS_FAILED = 'tests_failed',
  NO_DIFF_PRODUCED = 'no_diff_produced',
  ISSUE_NOT_ACTIONABLE = 'issue_not_actionable',
  GENE_MAP_CORRUPT = 'gene_map_corrupt',

  UNKNOWN = 'unknown',
}

export interface HelixErrorOptions {
  category: ErrorCategory;
  message: string;
  remediation: string[];
  cause?: Error | unknown;
  retryable?: boolean;
  docsUrl?: string;
}

export class HelixError extends Error {
  readonly category: ErrorCategory;
  readonly remediation: string[];
  readonly retryable: boolean;
  readonly docsUrl?: string;

  // Re-declare cause on top of the standard Error.cause so consumers can
  // narrow the type without an "as unknown" cast.
  readonly cause?: Error | unknown;

  constructor(opts: HelixErrorOptions) {
    super(opts.message);
    this.name = 'HelixError';
    this.category = opts.category;
    this.remediation = opts.remediation;
    this.cause = opts.cause;
    this.retryable = opts.retryable ?? false;
    this.docsUrl = opts.docsUrl;
  }
}
