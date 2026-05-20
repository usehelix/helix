import type { JiraIssue } from '../jira/client';

export type IssueSource = 'github' | 'jira' | 'linear';

/**
 * Source-agnostic reference to an issue we want to fix.
 *
 * Replaces the previous GHIssue-everywhere model that required Jira (and any
 * future source) to fake a GitHub-shaped object with `number=-1`.
 */
export interface IssueRef {
  source: IssueSource;
  /** GitHub: numeric string; Jira: "HELIX-123"; Linear: "ENG-456". */
  id: string;
  title: string;
  body: string;
  /** Browser-clickable URL to the source-of-truth issue. */
  url: string;
  /** Friendly identifier for branch names / PR titles. */
  displayName: string;
}

/** Minimal GitHub issue shape — defined here to avoid circular deps. */
export interface GHIssueLike {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
}

export function ghIssueToRef(issue: GHIssueLike): IssueRef {
  return {
    source: 'github',
    id: String(issue.number),
    title: issue.title,
    body: issue.body ?? '',
    url: issue.html_url,
    displayName: `#${issue.number}`,
  };
}

export function jiraIssueToRef(issue: JiraIssue, baseUrl: string, plainBody: string): IssueRef {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return {
    source: 'jira',
    id: issue.key,
    title: issue.fields.summary,
    body: plainBody,
    url: `${trimmed}/browse/${issue.key}`,
    displayName: issue.key,
  };
}

export function branchName(ref: IssueRef): string {
  const ts = Math.floor(Date.now() / 1000);
  const slug = ref.source === 'github' ? `issue-${ref.id}` : ref.id.toLowerCase();
  return `vialos/fix-${slug}-${ts}`;
}

export function prTitle(ref: IssueRef): string {
  return `fix(${ref.displayName}): ${ref.title}`;
}

export function prBodyCloseLine(ref: IssueRef): string {
  if (ref.source === 'github') return `Closes #${ref.id}`;
  if (ref.source === 'jira')   return `Resolves [${ref.id}](${ref.url})`;
  if (ref.source === 'linear') return `Closes ${ref.id}`;
  return `Related: ${ref.url}`;
}
