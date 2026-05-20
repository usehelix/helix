import { adfToPlainText, jiraIssueToTriageInput } from '../perceive-adapter';
import { JiraIssue, AdfDocument } from '../client';

describe('adfToPlainText', () => {
  it('extracts text from nested paragraph + codeBlock', () => {
    const adf: AdfDocument = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
        {
          type: 'codeBlock',
          content: [{ type: 'text', text: 'const x = 1;' }],
        },
      ],
    };
    const out = adfToPlainText(adf);
    expect(out).toContain('Hello world');
    expect(out).toContain('const x = 1;');
  });

  it('handles v2 plain string description (Jira REST API v2 compatibility)', () => {
    expect(adfToPlainText('plain text body')).toBe('plain text body');
  });

  it('returns empty string when description is null', () => {
    expect(adfToPlainText(null)).toBe('');
    expect(adfToPlainText(undefined)).toBe('');
  });

  it('handles hardBreak as newline', () => {
    const adf: AdfDocument = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'line 1' },
            { type: 'hardBreak' },
            { type: 'text', text: 'line 2' },
          ],
        },
      ],
    };
    expect(adfToPlainText(adf)).toContain('line 1');
    expect(adfToPlainText(adf)).toContain('line 2');
  });
});

describe('jiraIssueToTriageInput', () => {
  it('produces a TriageInput with source=jira and the issue key as sourceId', () => {
    const issue: JiraIssue = {
      key: 'HELIX-42',
      fields: {
        summary: 'Test bug',
        description: 'simple body',
        labels: ['bug', 'helix-ready'],
        project: { key: 'HELIX' },
        status: { name: 'To Do' },
        issuetype: { name: 'Bug' },
      },
    };
    const out = jiraIssueToTriageInput(issue);
    expect(out.source).toBe('jira');
    expect(out.sourceId).toBe('HELIX-42');
    expect(out.title).toBe('Test bug');
    expect(out.body).toBe('simple body');
    expect(out.labels).toEqual(['bug', 'helix-ready']);
  });
});
