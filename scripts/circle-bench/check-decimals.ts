/**
 * check-decimals.ts — one-off: dump the raw getWalletTokenBalance response
 * for our Arc Testnet payer wallet so we can see what `decimals` Circle's
 * API actually returns for USDC.
 *
 * Run:
 *   npm run check-decimals
 * or
 *   npx tsx --env-file=.env check-decimals.ts
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

const apiKey = requireEnv("CIRCLE_API_KEY");
const entitySecret = requireEnv("CIRCLE_ENTITY_SECRET");
const walletId = requireEnv("CIRCLE_WALLET_ID");

async function main() {
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  console.log(`Calling getWalletTokenBalance for wallet ${walletId}...`);
  const res = await client.getWalletTokenBalance({ id: walletId });

  console.log("\n--- res.data (raw, full) ---");
  console.log(JSON.stringify(res.data, null, 2));

  console.log("\n--- per-token decimals summary ---");
  const balances = res.data?.tokenBalances ?? [];
  for (const b of balances) {
    const t = b.token ?? {};
    console.log(
      `  symbol=${(t as any).symbol ?? "?"}  blockchain=${(t as any).blockchain ?? "?"}  decimals=${(t as any).decimals ?? "(not present)"}  amount=${b.amount ?? "?"}  tokenId=${(t as any).id ?? "?"}`,
    );
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
