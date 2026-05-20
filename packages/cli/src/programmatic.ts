/**
 * Programmatic wrappers around the existing CLI command logic.
 *
 * The CLI commands (`triageCommand`, `runCommand`) are interactive — they
 * `process.exit()` on errors, print to stdout, and return void. The Jira
 * webhook handler needs structured results without process-killing behavior,
 * so we expose these wrappers.
 *
 * Reuses: assessActionability, perceive, construct, executeplan, commit.
 */

import { assessActionability, ActionabilityResult } from './triage/actionability';
import { perceive, PerceiveResult } from './pcec/perceive';
import { construct, CapsuleHit } from './pcec/construct';
import { openGeneMap } from './pcec/db';
import { generatePlan, ExecutionPlan } from './execution/planner';
import { executeplan, ExecutionResult } from './execution/engine';
import { TriageInput } from './jira/perceive-adapter';
import { GHIssue } from './github/client';
import { IssueRef, ghIssueToRef } from './execution/issue-ref';

export interface ProgrammaticTriageResult {
  actionable: boolean;
  score: 'actionable' | 'needs_info' | 'not_actionable';
  confidence: number;
  reason: string;
  perceived: PerceiveResult;
  /** q_value from Gene Map if a capsule matched; 0 if not. */
  qValue: number;
  geneMapHit: boolean;
}

/**
 * Run actionability scoring + perceive + Gene Map lookup against a generic input.
 */
export async function triageProgrammatic(input: TriageInput): Promise<ProgrammaticTriageResult> {
  // Adapt to the GHIssue shape that assessActionability expects.
  const issueAdapter: Pick<GHIssue, 'number' | 'title' | 'body' | 'labels'> = {
    number: parseInt(input.sourceId, 10) || 0,
    title: input.title,
    body: input.body,
    labels: input.labels.map(name => ({ name })),
  };
  const actionability: ActionabilityResult = assessActionability(issueAdapter as GHIssue);

  const perceived = await perceive(input.title, input.body);

  let qValue = 0;
  let geneMapHit = false;
  try {
    const db = openGeneMap();
    const hit: CapsuleHit = construct(db, perceived.failure_code);
    if (hit.found && hit.capsule) {
      qValue = hit.capsule.q_value;
      geneMapHit = true;
    }
    db.close();
  } catch { /* gene map unavailable — non-fatal */ }

  return {
    actionable: actionability.score === 'actionable',
    score: actionability.score,
    confidence: actionability.confidence,
    reason: actionability.reason,
    perceived,
    qValue,
    geneMapHit,
  };
}

export interface ProgrammaticRunInput {
  /** TriageInput so we know the source + sourceId for branch naming. */
  input: TriageInput;
  /** The GitHub repo where the fix will be applied. */
  owner: string;
  repo: string;
  /** Token with push+PR permissions. */
  githubToken: string;
  /** Local path to a clone of `owner/repo`. */
  repoPath: string;
}

export interface ProgrammaticRunResult {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  filesChanged: string[];
  testsRun: boolean;
  testsPassed: boolean;
  error?: string;
  /** What perceive() classified this issue as. */
  perceived: PerceiveResult;
  /** Did the Gene Map have a matching capsule? */
  geneMapHit: boolean;
  qValue: number;
}

/**
 * Run the full plan → execute → PR pipeline non-interactively.
 *
 * Branch name encodes the source (e.g., `vialos/fix-jira-HELIX-123-...`) so that
 * collision with GitHub-sourced runs is avoided.
 */
export async function runProgrammatic(opts: ProgrammaticRunInput): Promise<ProgrammaticRunResult> {
  const { input, owner, repo, githubToken, repoPath } = opts;

  // Build a source-aware IssueRef. No more number=-1 hacks.
  if (input.source === 'manual') {
    throw new Error('runProgrammatic does not support source="manual"; pass github or jira');
  }
  const ref: IssueRef = {
    source: input.source,
    id: input.sourceId,
    title: input.title,
    body: input.body,
    url: input.source === 'github'
      ? `https://github.com/${owner}/${repo}/issues/${input.sourceId}`
      : `external:${input.sourceId}`,
    displayName: input.source === 'github' ? `#${input.sourceId}` : input.sourceId,
  };

  const plan: ExecutionPlan = await generatePlan(ref, repoPath);

  // Re-query Gene Map for return-value purposes (executeplan also does this internally).
  const perceived = await perceive(input.title, input.body);
  let qValue = 0;
  let geneMapHit = false;
  try {
    const db = openGeneMap();
    const hit = construct(db, perceived.failure_code);
    if (hit.found && hit.capsule) {
      qValue = hit.capsule.q_value;
      geneMapHit = true;
    }
    db.close();
  } catch { /* non-fatal */ }

  const result: ExecutionResult = await executeplan(plan, ref, repoPath, githubToken, owner, repo);

  return {
    success: result.success,
    prUrl: result.prUrl,
    prNumber: result.prNumber,
    filesChanged: result.filesChanged,
    testsRun: result.testsRun,
    testsPassed: result.testsPassed,
    error: result.error,
    perceived,
    geneMapHit,
    qValue,
  };
}
