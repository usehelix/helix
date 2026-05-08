/**
 * Seed Gene Registry Cloud with the SEED_GENES baseline.
 *
 *   npx tsx scripts/seed-registry.ts
 *   npx tsx scripts/seed-registry.ts --registry https://other-registry.example.com
 *
 * Reads packages/core/src/engine/seed-genes.ts and POSTs each capsule to
 * /v1/capsules. Idempotent — the worker upserts on (failure_code, category,
 * platform, strategy), so running this twice does not duplicate rows.
 */

import { SEED_GENES } from '../packages/core/src/engine/seed-genes.js';

const DEFAULT_REGISTRY = 'https://helix-telemetry.haimobai-adrian.workers.dev';

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const registry = getArg('registry') ?? process.env.GENE_REGISTRY_URL ?? DEFAULT_REGISTRY;
  const writeKey = getArg('write-key') ?? process.env.GENE_REGISTRY_WRITE_KEY;
  if (!writeKey) {
    console.error('✗ Missing write key. Set GENE_REGISTRY_WRITE_KEY env var or pass --write-key <secret>.');
    process.exit(2);
  }
  console.log(`→ Seeding ${SEED_GENES.length} capsules to ${registry}/v1/capsules`);

  let ok = 0;
  let fail = 0;
  for (const seed of SEED_GENES) {
    // Each seed gene lists multiple platforms; register a row per platform so
    // platform-scoped queries hit. Worker upserts on (code, category, platform, strategy).
    const platforms = seed.platforms.length ? seed.platforms : ['generic'];
    for (const platform of platforms) {
      const body = {
        failure_code: seed.failureCode,
        category: seed.category,
        platform,
        strategy: seed.strategy,
        q_value: seed.qValue,
        success_count: seed.successCount,
        total_count: seed.successCount,
        avg_repair_ms: seed.avgRepairMs,
        capsule_schema_version: 1,
        sdk_version: '0.1.0',
      };
      try {
        const res = await fetch(`${registry}/v1/capsules`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-registry-key': writeKey,
          },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          ok++;
          console.log(`  ✓ ${seed.failureCode} (${platform}) → ${seed.strategy} q=${seed.qValue}`);
        } else {
          fail++;
          const text = await res.text();
          console.error(`  ✗ ${seed.failureCode} (${platform}): HTTP ${res.status} ${text}`);
        }
      } catch (err: any) {
        fail++;
        console.error(`  ✗ ${seed.failureCode} (${platform}): ${err.message ?? err}`);
      }
    }
  }

  console.log(`\nDone — ${ok} ok, ${fail} failed`);
  if (fail > 0) {
    console.error(`✗ ${fail} push(es) failed — bailing without verification.`);
    process.exit(1);
  }

  // Self-verify: registry must hold at least the unique combos we pushed.
  // Equal on a fresh DB; greater on subsequent runs (idempotent UPSERTs do
  // not duplicate rows, but pre-existing rows from other writers count too).
  let stats: any;
  try {
    stats = await fetch(`${registry}/v1/stats`).then(r => r.json());
  } catch (err: any) {
    console.error(`✗ Could not fetch /v1/stats for verification: ${err.message ?? err}`);
    process.exit(1);
  }
  console.log('Registry stats:', stats);
  const observed = stats?.capsules ?? 0;
  if (observed < ok) {
    console.error(`✗ Verification failed: registry reports capsules=${observed} but we pushed ${ok}. Possible UPSERT collision or DB write loss.`);
    process.exit(1);
  }
  console.log(`✓ Verification: registry reports capsules=${observed} (>= ${ok} pushed).`);
}

main();
