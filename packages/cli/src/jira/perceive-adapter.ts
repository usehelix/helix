import { AdfDocument, AdfNode, JiraIssue } from './client';

/**
 * Source-agnostic input used by the programmatic triage/run pipeline.
 * GitHub-sourced issues have number+url; Jira-sourced issues use issueKey.
 */
export interface TriageInput {
  title: string;
  body: string;
  labels: string[];
  source: 'github' | 'jira' | 'manual';
  sourceId: string; // GitHub issue number as string OR Jira key like "HELIX-123"
}

const BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'codeBlock', 'bulletList', 'orderedList', 'listItem',
  'blockquote', 'rule', 'panel', 'table', 'tableRow',
]);

/**
 * Walk an ADF tree and emit plain text. Block-level nodes get a trailing newline.
 */
function walkAdf(nodes: AdfNode[]): string {
  return nodes.map(n => {
    if (n.type === 'text') return n.text || '';
    if (n.type === 'hardBreak') return '\n';
    const inner = n.content ? walkAdf(n.content) : '';
    return BLOCK_TYPES.has(n.type) ? `${inner}\n` : inner;
  }).join('');
}

export function adfToPlainText(adf: AdfDocument | string | null | undefined): string {
  if (!adf) return '';
  if (typeof adf === 'string') return adf; // Jira v2 API returns plain string
  if (!adf.content) return '';
  return walkAdf(adf.content).trim();
}

/**
 * Convert a Jira issue into the source-agnostic TriageInput used by perceive.
 */
export function jiraIssueToTriageInput(issue: JiraIssue): TriageInput {
  return {
    title: issue.fields.summary,
    body: adfToPlainText(issue.fields.description),
    labels: issue.fields.labels ?? [],
    source: 'jira',
    sourceId: issue.key,
  };
}
