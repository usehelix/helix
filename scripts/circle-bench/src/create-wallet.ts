import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initiateDeveloperControlledWalletsClient,
  registerEntitySecretCiphertext,
} from "@circle-fin/developer-controlled-wallets";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "output");
const envPath = path.join(projectRoot, ".env");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return v;
}

function appendEnv(lines: string[]) {
  appendFileSync(envPath, "\n" + lines.join("\n") + "\n");
}

async function main() {
  const apiKey = requireEnv("CIRCLE_API_KEY");

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  let entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!entitySecret) {
    entitySecret = randomBytes(32).toString("hex");
    console.log("Generated new entity secret. Registering with Circle...");
    console.log(`Recovery file will be written to: ${outputDir}/`);

    await registerEntitySecretCiphertext({
      apiKey,
      entitySecret,
      recoveryFileDownloadPath: outputDir,
    });

    appendEnv([`CIRCLE_ENTITY_SECRET=${entitySecret}`]);
    console.log("Entity secret registered and appended to .env");
    console.log(
      "CRITICAL: back up the recovery file in output/ — losing it means losing wallet access.",
    );
  } else {
    console.log("Using existing CIRCLE_ENTITY_SECRET from .env");
  }

  const client = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });

  console.log("\nCreating wallet set...");
  const walletSetRes = await client.createWalletSet({
    name: "Helix Circle Bench",
  });
  const walletSet = walletSetRes.data?.walletSet;
  if (!walletSet?.id) {
    throw new Error("createWalletSet returned no walletSet.id");
  }
  console.log(`Wallet set id: ${walletSet.id}`);

  console.log("\nCreating 2 ARC-TESTNET EOA wallets...");
  const walletsRes = await client.createWallets({
    walletSetId: walletSet.id,
    blockchains: ["ARC-TESTNET"],
    count: 2,
    accountType: "EOA",
  });

  const wallets = walletsRes.data?.wallets ?? [];
  if (wallets.length < 2) {
    throw new Error(`Expected 2 wallets, got ${wallets.length}`);
  }
  const [w1, w2] = wallets;

  writeFileSync(
    path.join(outputDir, "wallet-info.json"),
    JSON.stringify({ walletSet, wallets }, null, 2),
  );

  appendEnv([
    `CIRCLE_WALLET_ID=${w1.id}`,
    `CIRCLE_WALLET_ADDRESS=${w1.address}`,
    `CIRCLE_SECOND_WALLET_ID=${w2.id}`,
    `CIRCLE_SECOND_WALLET_ADDRESS=${w2.address}`,
    `CIRCLE_WALLET_BLOCKCHAIN=ARC-TESTNET`,
  ]);

  console.log("\n=== Created ===");
  console.log("Wallet 1 (agent payer):");
  console.log(`  id     : ${w1.id}`);
  console.log(`  address: ${w1.address}`);
  console.log("Wallet 2 (test recipient):");
  console.log(`  id     : ${w2.id}`);
  console.log(`  address: ${w2.address}`);
  console.log("Blockchain: ARC-TESTNET");
  console.log(`\nFull details: ${path.join(outputDir, "wallet-info.json")}`);

  console.log("\n=== Next step ===");
  console.log("Fund wallet 1 with testnet USDC:");
  console.log("  https://faucet.circle.com");
  console.log("  Chain  : Arc Testnet");
  console.log(`  Address: ${w1.address}`);
}

main().catch((err) => {
  console.error("\nFailed:", err);
  process.exit(1);
});
