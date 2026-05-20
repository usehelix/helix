export type ActionabilityScore = 'actionable' | 'needs_info' | 'not_actionable';

export interface MissingInfo {
  field: 'repro_steps' | 'acceptance_criteria' | 'scope' | 'size' | 'decision_needed';
  description: string;
}

export interface ActionabilityResult {
  score: ActionabilityScore;
  confidence: number;
  missing: MissingInfo[];
  reason: string;
  suggestedComment?: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
}

export function assessActionability(issue: GitHubIssue): ActionabilityResult {
  const body = issue.body || '';
  const title = issue.title.toLowerCase();
  const missing: MissingInfo[] = [];

  const hasReproSteps = checkReproSteps(body);
  const hasAcceptanceCriteria = checkAcceptanceCriteria(body);
  const hasScope = checkScope(body, title);
  const isDecisionNeeded = checkDecisionNeeded(body, title, issue.labels);
  const isTooLarge = checkTooLarge(body, title);

  if (!hasReproSteps) {
    missing.push({
      field: 'repro_steps',
      description: 'No reproduction steps or clear requirements found',
    });
  }
  if (!hasAcceptanceCriteria) {
    missing.push({
      field: 'acceptance_criteria',
      description: 'No acceptance criteria or expected behavior specified',
    });
  }
  if (!hasScope) {
    missing.push({
      field: 'scope',
      description: 'No specific files, functions, or endpoints mentioned',
    });
  }
  if (isDecisionNeeded) {
    missing.push({
      field: 'decision_needed',
      description: 'This requires an architectural or product decision',
    });
  }
  if (isTooLarge) {
    missing.push({
      field: 'size',
      description: 'Task appears too large — needs to be broken down',
    });
  }

  if (isDecisionNeeded || isTooLarge) {
    return {
      score: 'not_actionable',
      confidence: 0.85,
      missing,
      reason: isDecisionNeeded
        ? 'This issue requires an architectural or product decision before implementation'
        : 'This task is too large to be handled autonomously — please break it down into smaller issues',
    };
  }

  const requiredMet = hasReproSteps && hasAcceptanceCriteria;
  if (requiredMet) {
    return {
      score: 'actionable',
      confidence: hasScope ? 0.90 : 0.75,
      missing: [],
      reason: 'Issue has clear requirements and acceptance criteria',
    };
  }

  return {
    score: 'needs_info',
    confidence: 0.80,
    missing,
    reason: `Missing: ${missing.map(m => m.field.replace('_', ' ')).join(', ')}`,
    suggestedComment: buildComment(missing),
  };
}

function checkReproSteps(body: string): boolean {
  const patterns = [
    /steps to reproduce/i,
    /how to reproduce/i,
    /\d+\.\s+.{10,}/,
    /```[\s\S]*```/,
    /expected.*actual/is,
    /curl\s/i,
    /POST|GET|PUT|DELETE/,
    /requirements?:/i,
    /implement|add|create|fix|upgrade|update|bump/i,
    /npm\s+(install|run|test)/i,
    /package\.json/i,
  ];
  const matches = patterns.filter(p => p.test(body)).length;
  return matches >= 2 || body.length > 200;
}

function checkAcceptanceCriteria(body: string): boolean {
  const patterns = [
    /acceptance criteria/i,
    /expected behavior/i,
    /should (return|respond|accept|reject)/i,
    /must (return|respond|accept|reject)/i,
    /\[ \]/,
    /returns? \d{3}/i,
    /test command/i,
    /verified when/i,
    /done when/i,
  ];
  return patterns.some(p => p.test(body));
}

function checkScope(body: string, title: string): boolean {
  const combined = body + ' ' + title;
  const patterns = [
    /src\/\w/,
    /\w+\.(ts|js|py|go|rb)/,
    /\/api\/\w/,
    /function\s+\w+/i,
    /class\s+\w+/i,
    /\w+Controller|\w+Service|\w+Handler/i,
    /line \d+/i,
    /in `\w+`/,
  ];
  return patterns.some(p => p.test(combined));
}

function checkDecisionNeeded(
  body: string,
  title: string,
  labels: { name: string }[]
): boolean {
  const combined = (body + ' ' + title).toLowerCase();
  const decisionPatterns = [
    /should we (use|migrate|switch|adopt)/,
    /which (approach|option|tool|framework|library)/,
    /pros and cons/,
    /decision needed/,
    /open for discussion/,
    /rethink|reconsider|redesign the entire/,
    /architectural/,
  ];
  const hasDecisionLabel = labels.some(l =>
    ['discussion', 'question', 'RFC', 'proposal'].includes(l.name)
  );
  return hasDecisionLabel || decisionPatterns.some(p => p.test(combined));
}

function checkTooLarge(body: string, title: string): boolean {
  const combined = (body + ' ' + title).toLowerCase();
  const largeScopePatterns = [
    /entire (system|module|codebase|application)/,
    /rewrite (the|our|entire)/,
    /redesign (the|our|entire)/,
    /migrate (the|our|entire)/,
    /everything|all the|complete overhaul/,
  ];
  // Count distinct feature bullets — but exclude checkbox ACs ("- [ ] ...")
  // since well-scoped features can legitimately have many acceptance criteria.
  const featureCount = (body.match(/\n[-*]\s+(?!\[[\sx]\])/g) || []).length;
  return (
    largeScopePatterns.some(p => p.test(combined)) ||
    featureCount > 12
  );
}

function buildComment(missing: MissingInfo[]): string {
  const parts = [
    "Hi! I'd like to help with this issue, but I need a bit more context first:\n",
  ];

  for (const m of missing) {
    switch (m.field) {
      case 'repro_steps':
        parts.push(`**Missing: Reproduction steps or requirements**
Could you provide step-by-step instructions to reproduce the issue (or clear requirements if it's a feature)?
Example:
1. Send POST to \`/api/users\` with \`{ "email": "test@example.com" }\`
2. Expected: 201 Created
3. Actual: 500 Internal Server Error
`);
        break;
      case 'acceptance_criteria':
        parts.push(`**Missing: Acceptance criteria**
What does a successful fix/implementation look like?
Example: "The API returns 201 and the user appears in the database"
`);
        break;
      case 'scope':
        parts.push(`**Missing: Scope**
Which file(s), function(s), or endpoint(s) are affected?
Example: \`src/routes/users.ts\`, \`/api/users\` endpoint
`);
        break;
    }
  }

  parts.push('\nOnce you add these, I\'ll pick this up automatically. 🤖\n\n— VialOS');
  return parts.join('\n');
}
