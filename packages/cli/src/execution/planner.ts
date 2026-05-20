import Anthropic from '@anthropic-ai/sdk';
import { IssueRef, branchName as makeBranchName, prTitle as makePrTitle } from './issue-ref';

export interface ExecutionStep {
  index: number;
  title: string;
  description: string;
  type: 'read' | 'analyze' | 'implement' | 'test' | 'pr';
}

export interface ExecutionPlan {
  taskId: string;
  steps: ExecutionStep[];
  estimatedFiles: string[];
  testCommand: string;
  branchName: string;
  prTitle: string;
}

/**
 * Strip markdown code-fence wrapping from a Claude response. Claude often
 * wraps JSON in ```json … ``` despite instructions; this is exposed so
 * downstream callers (and tests) can rely on a pure helper.
 */
export function stripMarkdownFence(text: string): string {
  return text.replace(/```json\n?|```\n?/g, '').trim();
}

// Default fallback plan used when the LLM is unavailable or returns malformed JSON.
const DEFAULT_STEPS: ExecutionStep[] = [
  { index: 1, title: 'Read relevant files', description: 'Find the code related to this issue', type: 'read' },
  { index: 2, title: 'Understand root cause', description: 'Analyze why the bug occurs', type: 'analyze' },
  { index: 3, title: 'Implement fix', description: 'Apply the fix based on issue description', type: 'implement' },
  { index: 4, title: 'Run tests', description: 'Verify fix works', type: 'test' },
  { index: 5, title: 'Open PR', description: 'Create pull request', type: 'pr' },
];

export async function generatePlan(
  ref: IssueRef,
  _repoPath: string
): Promise<ExecutionPlan> {
  let parsed: { steps?: ExecutionStep[]; estimatedFiles?: string[]; testCommand?: string; prTitle?: string } = {};

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are analyzing an issue to create an execution plan.

Issue Title: ${ref.title}

Issue Body:
${ref.body}

For TypeScript/Next.js repos, look for the most specific file path. Respond ONLY with raw JSON, no markdown backticks.

{
  "steps": [
    { "index": 1, "title": "...", "description": "...", "type": "read" },
    { "index": 2, "title": "...", "description": "...", "type": "analyze" },
    { "index": 3, "title": "...", "description": "...", "type": "implement" },
    { "index": 4, "title": "...", "description": "...", "type": "test" },
    { "index": 5, "title": "...", "description": "...", "type": "pr" }
  ],
  "estimatedFiles": ["path/to/file.ts"],
  "testCommand": "npm test",
  "prTitle": "fix: ..."
}`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    parsed = JSON.parse(stripMarkdownFence(text));
  } catch {
    // Either no API key, network error, or unparseable response. Fall back gracefully.
    parsed = {};
  }

  return {
    taskId: `task-${ref.source}-${ref.id}-${Date.now()}`,
    steps: parsed.steps && parsed.steps.length > 0 ? parsed.steps : DEFAULT_STEPS,
    estimatedFiles: parsed.estimatedFiles || [],
    testCommand: parsed.testCommand || 'npm test',
    branchName: makeBranchName(ref),
    prTitle: parsed.prTitle || makePrTitle(ref),
  };
}
