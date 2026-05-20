import { ghIssueToRef, jiraIssueToRef, branchName, prTitle, prBodyCloseLine, IssueRef } from '../issue-ref';
import type { JiraIssue } from '../../jira/client';

describe('ghIssueToRef + branchName', () => {
  it('produces a github-source ref with #N displayName and vialos/fix-issue-N-<ts> branch', () => {
    const ref = ghIssueToRef({
      number: 42,
      title: 'bug: thing broke',
      body: 'details',
      html_url: 'https://github.com/o/r/issues/42',
    });
    expect(ref.source).toBe('github');
    expect(ref.id).toBe('42');
    expect(ref.displayName).toBe('#42');
    const branch = branchName(ref);
    expect(branch).toMatch(/^vialos\/fix-issue-42-\d+$/);
  });
});

describe('jiraIssueToRef + branchName', () => {
  it('produces a jira-source ref with lowercase slug branch', () => {
    const jiraIssue: JiraIssue = {
      key: 'HELIX-123',
      fields: {
        summary: 'login is broken',
        description: null,
        labels: [],
        project: { key: 'HELIX' },
        status: { name: 'To Do' },
        issuetype: { name: 'Bug' },
      },
    };
    const ref = jiraIssueToRef(jiraIssue, 'https://acme.atlassian.net', 'plain body');
    expect(ref.source).toBe('jira');
    expect(ref.id).toBe('HELIX-123');
    expect(ref.displayName).toBe('HELIX-123');
    expect(ref.url).toBe('https://acme.atlassian.net/browse/HELIX-123');
    const branch = branchName(ref);
    expect(branch).toMatch(/^vialos\/fix-helix-123-\d+$/);
  });

  it('strips trailing slash from baseUrl when building Jira URL', () => {
    const jiraIssue: JiraIssue = {
      key: 'HELIX-1',
      fields: { summary: 's', description: null, labels: [], project: { key: 'HELIX' }, status: { name: '' }, issuetype: { name: '' } },
    };
    const ref = jiraIssueToRef(jiraIssue, 'https://acme.atlassian.net/', '');
    expect(ref.url).toBe('https://acme.atlassian.net/browse/HELIX-1');
  });
});

describe('prTitle', () => {
  it('renders fix(<displayName>): <title>', () => {
    const ref: IssueRef = {
      source: 'github', id: '7', title: 'fix this thing',
      body: '', url: '', displayName: '#7',
    };
    expect(prTitle(ref)).toBe('fix(#7): fix this thing');
  });
});

describe('prBodyCloseLine', () => {
  it('emits "Closes #N" for github source', () => {
    const ref: IssueRef = { source: 'github', id: '99', title: 't', body: '', url: 'u', displayName: '#99' };
    expect(prBodyCloseLine(ref)).toBe('Closes #99');
  });

  it('emits a Jira browse link for jira source', () => {
    const ref: IssueRef = { source: 'jira', id: 'HELIX-9', title: 't', body: '', url: 'https://x/browse/HELIX-9', displayName: 'HELIX-9' };
    expect(prBodyCloseLine(ref)).toBe('Resolves [HELIX-9](https://x/browse/HELIX-9)');
  });

  it('emits "Closes ENG-N" for linear source', () => {
    const ref: IssueRef = { source: 'linear', id: 'ENG-456', title: 't', body: '', url: 'u', displayName: 'ENG-456' };
    expect(prBodyCloseLine(ref)).toBe('Closes ENG-456');
  });
});
