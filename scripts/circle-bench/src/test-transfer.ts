import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return v;
}

const apiKey = requireEnv("CIRCLE_API_KEY");
const entitySecret = requireEnv("CIRCLE_ENTITY_SECRET");
const sourceWalletId = requireEnv("CIRCLE_WALLET_ID");
const destinationAddress = requireEnv("CIRCLE_SECOND_WALLET_ADDRESS");

const amount = process.argv[2] ?? "0.01";

const TERMINAL_OK = new Set(["CONFIRMED", "COMPLETE"]);
const TERMINAL_BAD = new Set(["FAILED", "DENIED", "CANCELLED"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  console.log(`Source wallet     : ${sourceWalletId}`);
  console.log(`Destination addr  : ${destinationAddress}`);
  console.log(`Amount            : ${amount} USDC\n`);

  console.log("Fetching source wallet token balances...");
  const balRes = await client.getWalletTokenBalance({ id: sourceWalletId });
  const balances = balRes.data?.tokenBalances ?? [];
  if (balances.length === 0) {
    throw new Error("No token balances on source wallet. Did you fund it?");
  }

  for (const b of balances) {
    console.log(`  ${b.token?.symbol ?? "?"}: ${b.amount} (tokenId=${b.token?.id})`);
  }

  const usdc = balances.find((b) => b.token?.symbol === "USDC");
  if (!usdc?.token?.id) {
    throw new Error("USDC not found on source wallet token balances.");
  }
  if (parseFloat(usdc.amount ?? "0") < parseFloat(amount)) {
    throw new Error(`Insufficient USDC: have ${usdc.amount}, need ${amount}`);
  }
  const tokenId = usdc.token.id;

  console.log(`\nCreating transaction... (USDC tokenId=${tokenId})`);
  const txRes = await client.createTransaction({
    walletId: sourceWalletId,
    destinationAddress,
    tokenId,
    amounts: [amount],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  const txId = txRes.data?.id;
  if (!txId) throw new Error("createTransaction returned no id");
  console.log(`Transaction id: ${txId}`);
  console.log("Polling for confirmation (every 3s, 2min timeout)...\n");

  const deadline = Date.now() + 120_000;
  let lastState = "";
  let finalTx: any = null;

  while (Date.now() < deadline) {
    await sleep(3000);
    const poll = await client.getTransaction({ id: txId });
    const tx = poll.data?.transaction;
    const state = tx?.state ?? "UNKNOWN";

    if (state !== lastState) {
      console.log(`  state: ${state}${tx?.txHash ? "  tx=" + tx.txHash : ""}`);
      lastState = state;
    }

    if (TERMINAL_OK.has(state) || TERMINAL_BAD.has(state)) {
      finalTx = tx;
      break;
    }
  }

  if (!finalTx) {
    throw new Error("Polling timed out before transaction reached a terminal state");
  }

  console.log("\n=== Final ===");
  console.log(`state    : ${finalTx.state}`);
  console.log(`txHash   : ${finalTx.txHash ?? "(none)"}`);
  console.log(`blockHash: ${finalTx.blockHash ?? "(none)"}`);
  console.log(`fee      : ${JSON.stringify(finalTx.networkFee ?? finalTx.fee ?? null)}`);

  if (TERMINAL_BAD.has(finalTx.state)) {
    console.error(`\nTransaction did not succeed: state=${finalTx.state}`);
    if (finalTx.errorReason) console.error(`reason: ${finalTx.errorReason}`);
    process.exit(2);
  }

  console.log("\nChecking destination balance...");
  const destBalRes = await client.getWalletTokenBalance({
    id: requireEnv("CIRCLE_SECOND_WALLET_ID"),
  });
  const destBalances = destBalRes.data?.tokenBalances ?? [];
  const destUsdc = destBalances.find((b) => b.token?.symbol === "USDC");
  console.log(`  destination USDC: ${destUsdc?.amount ?? "0"}`);
}

main().catch((err) => {
  console.error("\nFailed:", err?.response?.data ?? err);
  process.exit(1);
});
