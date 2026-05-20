import { Octokit } from '@octokit/rest';

export interface GHIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: { name: string }[];
  html_url: string;
  user: { login: string } | null;
  created_at: string;
}

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(token: string, owner: string, repo: string) {
    this.octokit = new Octokit({ auth: token });
    this.owner = owner;
    this.repo = repo;
  }

  async listOpenIssues(): Promise<GHIssue[]> {
    const issues: GHIssue[] = [];
    let page = 1;

    while (true) {
      const res = await this.octokit.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: 'open',
        per_page: 100,
        page,
      });

      const realIssues = (res.data as any[]).filter(i => !i.pull_request) as GHIssue[];
      issues.push(...realIssues);

      if (res.data.length < 100) break;
      page++;
    }

    return issues;
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        labels: [label],
      });
    } catch {
      // Label might not exist, ignore
    }
  }

  // ── Used by `vial run` ──

  async getIssue(issueNumber: number): Promise<GHIssue> {
    const res = await this.octokit.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });
    return res.data as unknown as GHIssue;
  }

  async createPR(params: {
    title: string;
    body: string;
    branch: string;
    base: string;
  }): Promise<{ url: string; number: number }> {
    const res = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: params.title,
      body: params.body,
      head: params.branch,
      base: params.base,
    });
    return { url: res.data.html_url, number: res.data.number };
  }

  async findExistingPR(branch: string): Promise<string | null> {
    const res = await this.octokit.pulls.list({
      owner: this.owner,
      repo: this.repo,
      head: `${this.owner}:${branch}`,
      state: 'open',
    });
    return res.data.length > 0 ? res.data[0].html_url : null;
  }

  async getDefaultBranch(): Promise<string> {
    const res = await this.octokit.repos.get({ owner: this.owner, repo: this.repo });
    return res.data.default_branch;
  }
}
