import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import { ExecutionPlan } from './planner';

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

interface FixChange {
  file: string;
  oldCode: string;
  newCode: string;
}

// Named `executeplan` (lowercase 'p') to match the spec.
// eslint-disable-next-line @typescript-eslint/naming-convention
export async function executeplan(
  plan: ExecutionPlan,
  repoPath: string,
  githubToken: string,
  owner: string,
  repo: string,
): Promise<ExecutionResult> {
  const client = new Anthropic();
  const filesChanged: string[] = [];

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
      const searchResponse = await client.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Issue: ${plan.issue.title}

Body: ${plan.issue.body}

What file(s) in a Node.js/TypeScript project would contain this code?
List only the most likely 1-3 file paths relative to project root.
Format: one path per line, no explanation.`,
        }],
      });

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

    // 3. Ask Claude for the exact code change.
    const fixResponse = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `You are fixing a bug in a TypeScript/Node.js project.

Issue: ${plan.issue.title}

Description:
${plan.issue.body}

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
- Respond ONLY with the JSON, no markdown backticks`,
      }],
    });

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

    // 5. Run tests (best-effort — failure is logged but does not block PR creation).
    let testsPassed = false;
    let testsRun = false;
    try {
      await execAsync(plan.testCommand, { cwd: repoPath, timeout: 120000 });
      testsPassed = true;
      testsRun = true;
    } catch (testError: any) {
      testsRun = true;
      testsPassed = false;
      console.error('Tests failed:', String(testError.message ?? testError).slice(0, 200));
    }

    // 6. Commit + push.
    execSync(`git add ${filesChanged.map(f => `'${f}'`).join(' ')}`, { cwd: repoPath, stdio: 'pipe' });
    const commitMsg = `${plan.prTitle} (closes #${plan.issue.number})`;
    execSync(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd: repoPath, stdio: 'pipe' });
    execSync(`git push origin ${plan.branchName}`, { cwd: repoPath, stdio: 'pipe' });

    // 7. Open PR.
    const octokit = new Octokit({ auth: githubToken });
    const repoInfo = await octokit.repos.get({ owner, repo });
    const baseBranch = repoInfo.data.default_branch;

    const pr = await octokit.pulls.create({
      owner,
      repo,
      title: plan.prTitle,
      head: plan.branchName,
      base: baseBranch,
      body: buildPRBody(plan, filesChanged, testsPassed),
    });

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
    try {
      execSync('git checkout main || git checkout master', { cwd: repoPath, stdio: 'pipe' });
    } catch { /* ignore */ }

    return {
      success: false,
      error: error?.message ?? String(error),
      filesChanged,
      testsRun: false,
      testsPassed: false,
    };
  }
}

function buildPRBody(plan: ExecutionPlan, filesChanged: string[], testsPassed: boolean): string {
  return `## Summary
Fixes #${plan.issue.number} — ${plan.issue.title}

## Changes
${filesChanged.map(f => `- \`${f}\``).join('\n')}

## Testing
${testsPassed ? '✅ Tests passing' : '⚠️ Tests not verified — please review manually'}

## Root Cause
${(plan.issue.body ?? '').slice(0, 300)}...

---
*Opened by [VialOS](https://github.com/adrianhihi/helix) — Ticket-to-PR automation*`;
}
