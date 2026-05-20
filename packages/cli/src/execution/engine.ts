import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { Octokit } from '@octokit/rest';
import { ExecutionPlan } from './planner';
import { IssueRef, prBodyCloseLine } from './issue-ref';
import { perceive, PerceiveResult } from '../pcec/perceive';
import { construct, buildPromptWithCapsule, CapsuleHit } from '../pcec/construct';
import { commit, detectAndCorrectMisclassification } from '../pcec/commit';
import { openGeneMap } from '../pcec/db';
import { errors } from '../errors/factories';
import { wrapClaudeCall } from '../errors/wrap';

const execAsync = promisify(exec);

export interface ExecutionResult {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  error?: string;
  filesChanged: string[];
  testsRun: boolean;
  testsPassed: boolean;
}

export interface RunOptions {
  /** Skip the test step before pushing. PR body will annotate this. */
  skipTests?: boolean;
}

interface FixChange {
  file: string;
  oldCode: string;
  newCode: string;
}

// Named `executeplan` (lowercase 'p') to match the spec.
// eslint-disable-next-line @typescript-eslint/naming-convention
export async function executeplan(
  plan: ExecutionPlan,
  ref: IssueRef,
  repoPath: string,
  githubToken: string,
  owner: string,
  repo: string,
  options: RunOptions = {},
): Promise<ExecutionResult> {
  const skipTests = !!options.skipTests;
  const client = new Anthropic();
  const filesChanged: string[] = [];

  // ── PCEC Step 1: PERCEIVE ──
  // Classify the issue into a failure_code so we can look up matching capsules.
  // Computed outside the try block so commit() in the catch block can reference it.
  const perceiveResult: PerceiveResult = await perceive(ref.title, ref.body);
  console.log(`  [PCEC] Perceived: ${perceiveResult.failure_code} (${Math.round(perceiveResult.confidence * 100)}%)`);

  // ── PCEC Step 2: CONSTRUCT — Gene Map lookup ──
  let db: Database.Database | null = null;
  let capsuleHit: CapsuleHit = { found: false };
  try {
    db = openGeneMap();
    capsuleHit = construct(db, perceiveResult.failure_code);
    if (capsuleHit.found && capsuleHit.capsule) {
      console.log(`  [PCEC] Gene Map hit: ${capsuleHit.capsule.failure_code} (q=${capsuleHit.capsule.q_value.toFixed(2)})`);
    } else {
      console.log(`  [PCEC] Gene Map miss — using LLM analysis`);
    }
  } catch {
    // Gene Map unavailable — proceed without it. PCEC degrades gracefully.
  }

  try {
    // 1. Create new branch
    execSync(`git checkout -b ${plan.branchName}`, { cwd: repoPath, stdio: 'pipe' });

    // 2. Gather file context — either from estimatedFiles, or ask Claude to find them.
    let fileContext = '';
    for (const filePath of plan.estimatedFiles) {
      const fullPath = path.join(repoPath, filePath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        fileContext += `\n\n=== ${filePath} ===\n${content}`;
      }
    }

    if (!fileContext) {
      const searchResponse = await wrapClaudeCall(() => client.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Issue: ${ref.title}

Body: ${ref.body}

What file(s) in a Node.js/TypeScript project would contain this code?
List only the most likely 1-3 file paths relative to project root.
Format: one path per line, no explanation.`,
        }],
      }));

      const searchText = searchResponse.content[0].type === 'text'
        ? searchResponse.content[0].text
        : '';

      const likelyFiles = searchText.trim().split('\n').filter(Boolean);
      for (const filePath of likelyFiles) {
        const fullPath = path.join(repoPath, filePath.trim());
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          fileContext += `\n\n=== ${filePath.trim()} ===\n${content}`;
        }
      }
    }

    // 3. Ask Claude for the exact code change — injecting Gene Map hint if available.
    const baseFixPrompt = `You are fixing a bug in a TypeScript/Node.js project.

Issue: ${ref.title}

Description:
${ref.body}

Current file contents:
${fileContext}

Provide the EXACT fix as a JSON object:
{
  "changes": [
    {
      "file": "relative/path/to/file.ts",
      "oldCode": "exact string to find and replace",
      "newCode": "exact replacement code"
    }
  ],
  "explanation": "Brief explanation of the fix"
}

Rules:
- oldCode must be an EXACT substring found in the file
- Make minimal changes to fix the specific bug
- Follow the existing code style
- Respond ONLY with the JSON, no markdown backticks`;

    const fixPrompt = buildPromptWithCapsule(baseFixPrompt, capsuleHit);

    const fixResponse = await wrapClaudeCall(() => client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 3000,
      messages: [{ role: 'user', content: fixPrompt }],
    }));

    const fixText = fixResponse.content[0].type === 'text'
      ? fixResponse.content[0].text
      : '';

    let fixParsed: { changes: FixChange[]; explanation?: string };
    try {
      fixParsed = JSON.parse(fixText.trim());
    } catch {
      throw new Error(`Failed to parse fix response: ${fixText.slice(0, 200)}`);
    }

    // 4. Apply the fix.
    for (const change of fixParsed.changes) {
      const fullPath = path.join(repoPath, change.file);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${change.file}`);
      }
      let content = fs.readFileSync(fullPath, 'utf8');
      if (!content.includes(change.oldCode)) {
        throw new Error(`Could not find target code in ${change.file}.\nLooking for:\n${change.oldCode}`);
      }
      content = content.replace(change.oldCode, change.newCode);
      fs.writeFileSync(fullPath, content, 'utf8');
      filesChanged.push(change.file);
    }

    // 5. Run tests. On failure: save the diff to .helix/last-diff.patch, reset
    //    the working tree, and throw a friendly HelixError so we DON'T push a
    //    broken fix. With --skip-tests the PR body annotates the warning instead.
    let testsPassed = false;
    let testsRun = false;
    if (skipTests) {
      console.log('  [helix] --skip-tests: not running tests before push');
    } else {
      try {
        await execAsync(plan.testCommand, { cwd: repoPath, timeout: 120000 });
        testsPassed = true;
        testsRun = true;
      } catch (testError: any) {
        testsRun = true;
        testsPassed = false;
        console.error('Tests failed:', String(testError.message ?? testError).slice(0, 200));

        // Save the diff before resetting so the user can recover the fix.
        const diffDir = path.join(repoPath, '.helix');
        const diffPath = path.join(diffDir, 'last-diff.patch');
        try {
          fs.mkdirSync(diffDir, { recursive: true });
          const diffOutput = execSync('git diff', { cwd: repoPath }).toString();
          fs.writeFileSync(diffPath, diffOutput);
        } catch { /* best-effort — fall through to error */ }

        // Reset working tree so we don't leave half-applied state behind.
        try {
          execSync('git reset --hard HEAD', { cwd: repoPath, stdio: 'pipe' });
        } catch { /* non-fatal */ }

        // PCEC: commit the failure so q-value decays on the matched capsule.
        if (db) {
          try {
            commit(db, {
              perceiveResult,
              strategy: 'tests_failed',
              filesChanged,
              prUrl: '',
              success: false,
              repoName: `${owner}/${repo}`,
              issueNumber: parseInt(ref.id, 10) || 0,
              issueSource: ref.source,
              issueId: ref.id,
            });
          } catch { /* ignore */ }
          db.close();
        }

        // Approximate failure count from stderr; fall back to 1.
        const failureMatch = String(testError.message ?? '').match(/(\d+) failed/i);
        const failureCount = failureMatch ? Number(failureMatch[1]) : 1;
        throw errors.testsFailed(plan.testCommand, failureCount);
      }
    }

    // 6. Commit + push.
    execSync(`git add ${filesChanged.map(f => `'${f}'`).join(' ')}`, { cwd: repoPath, stdio: 'pipe' });
    const commitMsg = `${plan.prTitle} (${prBodyCloseLine(ref)})`;
    execSync(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd: repoPath, stdio: 'pipe' });
    execSync(`git push origin ${plan.branchName}`, { cwd: repoPath, stdio: 'pipe' });

    // 7. Open PR. If this step fails the branch is already pushed — surface a
    //    HelixError with the manual command so the user can recover.
    const octokit = new Octokit({ auth: githubToken });
    const repoInfo = await octokit.repos.get({ owner, repo });
    const baseBranch = repoInfo.data.default_branch;

    let pr: { data: { html_url: string; number: number } };
    try {
      pr = await octokit.pulls.create({
        owner,
        repo,
        title: plan.prTitle,
        head: plan.branchName,
        base: baseBranch,
        body: buildPRBody(plan, ref, filesChanged, testsPassed, skipTests),
      });
    } catch (prErr: any) {
      throw errors.githubPRCreateFailed(
        prErr?.message ?? 'unknown error',
        plan.branchName,
        `${owner}/${repo}`,
      );
    }

    // Gather the actual diff for hint-usage scoring + reverse classification.
    let actualDiff = '';
    try {
      const { stdout } = await execAsync('git diff HEAD~1', { cwd: repoPath });
      actualDiff = stdout;
    } catch { /* diff capture failure is non-fatal */ }

    // ── PCEC Step 4: COMMIT (success path) ──
    if (db) {
      try {
        commit(db, {
          perceiveResult,
          strategy: fixParsed.changes?.[0] ? 'code_edit' : 'unknown',
          filesChanged,
          actualDiff,
          capsuleHint: capsuleHit.found ? capsuleHit.capsule?.hint : undefined,
          prUrl: pr.data.html_url,
          success: true,
          repoName: `${owner}/${repo}`,
          issueNumber: parseInt(ref.id, 10) || 0,
          issueSource: ref.source,
          issueId: ref.id,
        });
        console.log(`  [PCEC] Gene Capsule saved (${perceiveResult.failure_code})`);
      } catch (commitErr: any) {
        console.error(`  [PCEC] commit failed: ${commitErr?.message ?? commitErr}`);
      } finally {
        db.close();
      }
    }

    // ── Reverse classification: fire-and-forget, doesn't block the return.
    // Opens its own DB connection so it's safe after the main db.close() above.
    if (actualDiff) {
      detectAndCorrectMisclassification(
        perceiveResult.failure_code,
        actualDiff,
        ref.title,
      ).then(result => {
        if (result.corrected) {
          console.log(`  [PCEC] Reclassified: ${perceiveResult.failure_code} → ${result.actualCode}`);
        }
      }).catch(() => { /* non-fatal */ });
    }

    return {
      success: true,
      prUrl: pr.data.html_url,
      prNumber: pr.data.number,
      filesChanged,
      testsRun,
      testsPassed,
    };
  } catch (error: any) {
    // Cleanup: return to default branch so the working tree is left tidy.
    // For PR-creation failures we leave the branch on its post-push state so
    // the user can `gh pr create` manually — but checkout away from it to a
    // safe spot anyway.
    try {
      execSync('git checkout main || git checkout master', { cwd: repoPath, stdio: 'pipe' });
    } catch { /* ignore */ }

    // If this is already a friendly HelixError (testsFailed / githubPRCreateFailed
    // / wrapClaudeCall translations), let it propagate so the top-level handler
    // shows remediation. Plain errors fall through to the ExecutionResult below.
    const isHelix = error && typeof error === 'object' && (error as { name?: string }).name === 'HelixError';
    if (isHelix) {
      throw error;
    }

    // ── PCEC Step 4: COMMIT (failure path — decays q_value if capsule existed) ──
    if (db) {
      try {
        commit(db, {
          perceiveResult,
          strategy: 'failed',
          filesChanged,
          prUrl: '',
          success: false,
          repoName: `${owner}/${repo}`,
          issueNumber: parseInt(ref.id, 10) || 0,
          issueSource: ref.source,
          issueId: ref.id,
        });
      } catch { /* ignore */ }
      finally {
        db.close();
      }
    }

    return {
      success: false,
      error: error?.message ?? String(error),
      filesChanged,
      testsRun: false,
      testsPassed: false,
    };
  }
}

function buildPRBody(
  plan: ExecutionPlan,
  ref: IssueRef,
  filesChanged: string[],
  testsPassed: boolean,
  skipTests: boolean,
): string {
  const testingLine = skipTests
    ? '⚠️ This PR was generated with --skip-tests. Verify before merging.'
    : testsPassed
      ? '✅ Tests passing'
      : '⚠️ Tests not verified — please review manually';
  return `## Summary
${prBodyCloseLine(ref)} — ${ref.title}

## Changes
${filesChanged.map(f => `- \`${f}\``).join('\n')}

## Testing
${testingLine}

## Root Cause
${ref.body.slice(0, 300)}...

---
*Opened by [VialOS](https://github.com/adrianhihi/helix) — Ticket-to-PR automation*`;
}
