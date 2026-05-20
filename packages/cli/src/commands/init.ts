import Conf from 'conf';
import { execSync } from 'child_process';
import { openGeneMap, GENE_MAP_DB_PATH } from '../pcec/db';

interface VialConfig {
  githubToken: string;
  owner: string;
  repo: string;
}

const config = new Conf<VialConfig>({ projectName: 'vialos' });

export async function initCommand(options: { repo?: string }): Promise<void> {
  console.log('\n🔧 VialOS init\n');

  let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  if (!token) {
    try {
      token = execSync('gh auth token', { encoding: 'utf8' }).trim();
    } catch {
      console.error('❌ No GitHub token found.');
      console.error('   Set GITHUB_TOKEN env var, or run: gh auth login');
      process.exit(1);
    }
  }

  let owner: string;
  let repo: string;

  if (options.repo) {
    const parts = options.repo.split('/');
    if (parts.length !== 2) {
      console.error('❌ Invalid repo format. Use: owner/repo');
      process.exit(1);
    }
    [owner, repo] = parts;
  } else {
    try {
      const remote = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
      const match = remote.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
      if (!match) throw new Error('Not a GitHub repo');
      owner = match[1];
      repo = match[2];
    } catch {
      console.error('❌ Cannot detect GitHub repo.');
      console.error('   Run: vial init --repo owner/repo');
      process.exit(1);
    }
  }

  config.set('githubToken', token!);
  config.set('owner', owner);
  config.set('repo', repo);

  // Bootstrap the Gene Map DB if it doesn't already exist.
  try {
    const db = openGeneMap();
    db.close();
    console.log(`  Gene Map: initialized at ${GENE_MAP_DB_PATH}`);
  } catch (err: any) {
    console.warn(`  Gene Map: failed to initialize (${err?.message ?? err})`);
  }

  console.log(`✅ Initialized VialOS for ${owner}/${repo}`);
  console.log(`\nNext: run 'vial triage' to see which issues are actionable`);
}

export function getConfig(): VialConfig {
  const token = config.get('githubToken');
  const owner = config.get('owner');
  const repo = config.get('repo');

  if (!token || !owner || !repo) {
    console.error('❌ Not initialized. Run: vial init');
    process.exit(1);
  }

  return { githubToken: token, owner, repo };
}
