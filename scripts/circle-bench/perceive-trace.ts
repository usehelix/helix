/**
 * Diagnostic harness for the PCEC adapter chain. Use to verify
 * which adapter claims a given error, especially when adding new
 * platform adapters or testing new Circle SDK versions (v7 raw axios
 * vs v10+ custom error class). Loads the BUILT dist (not src) so it
 * exercises the same code path the demo + downstream consumers use.
 */
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { defaultAdapters, wrap, createEngine } from '../../packages/core/dist/index.js';
import * as fs from 'node:fs';

async function trigger(label: string, errorMaker: () => Promise<any>) {
  try { fs.unlinkSync('./trace-genes.db'); fs.unlinkSync('./trace-genes-vial-genes.db'); } catch {}
  const safe = wrap(errorMaker, {
    mode: 'auto',
    agentId: 'trace-' + label,
    geneMapPath: './trace-genes.db',
    context: { platform: 'circle', apiLayer: 'wallets-api' },
    llm: { provider: 'anthropic', enabled: !!process.env.ANTHROPIC_API_KEY },
    verbose: false,
  });
  try { await safe(); } catch {}
  const eng = createEngine({ mode: 'observe', agentId: 'inspector', geneMapPath: './trace-genes.db' });
  const audit = eng.getGeneMap().getAuditLog(10);
  console.log(`\n--- ${label} ---`);
  for (const a of audit) console.log(`  ${a.immune ? 'IMMUNE' : 'REPAIR'}  ${a.failureCode.padEnd(28)} ${a.strategy}`);
  eng.getGeneMap().close();
}

async function main() {
  const client = initiateDeveloperControlledWalletsClient({ apiKey: process.env.CIRCLE_API_KEY!, entitySecret: process.env.CIRCLE_ENTITY_SECRET! });
  const balRes = await client.getWalletTokenBalance({ id: process.env.CIRCLE_WALLET_ID! });
  const tokenId = balRes.data?.tokenBalances?.find((b: any) => b.token?.symbol === 'USDC')?.token?.id;
  const base = { walletId: process.env.CIRCLE_WALLET_ID!, destinationAddress: process.env.CIRCLE_SECOND_WALLET_ADDRESS!, tokenId, fee: { type: 'level' as const, config: { feeLevel: 'MEDIUM' as const } } };

  // Trigger 2: param invalid (single call, deterministic)
  await trigger('PARAM-INVALID', async () => client.createTransaction({ ...base, amount: ['0.001'], idempotencyKey: 'bad-uuid' } as any));

  try { fs.unlinkSync('./trace-genes.db'); fs.unlinkSync('./trace-genes-vial-genes.db'); } catch {}
}
main().catch(console.error);
