import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

const apiKey = requireEnv("CIRCLE_API_KEY");
const entitySecret = requireEnv("CIRCLE_ENTITY_SECRET");
const walletId = requireEnv("CIRCLE_WALLET_ID");
const destinationAddress = requireEnv("CIRCLE_SECOND_WALLET_ADDRESS");

const TERMINAL_OK = new Set(["CONFIRMED", "COMPLETE"]);
const TERMINAL_BAD = new Set(["FAILED", "DENIED", "CANCELLED"]);
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

let cachedUsdcTokenId: string | null = null;

async function getUsdcTokenId(): Promise<string> {
  if (cachedUsdcTokenId) return cachedUsdcTokenId;
  const balRes = await client.getWalletTokenBalance({ id: walletId });
  const balances = balRes.data?.tokenBalances ?? [];
  const usdc = balances.find((b) => b.token?.symbol === "USDC");
  if (!usdc?.token?.id) {
    throw new CircleError("USDC tokenId not found on source wallet token balances");
  }
  cachedUsdcTokenId = usdc.token.id;
  return cachedUsdcTokenId;
}

export class CircleError extends Error {
  constructor(
    message: string,
    public state?: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "CircleError";
  }
}

export interface PayResult {
  tx_id: string;
  tx_hash: string;
  state: string;
}

export async function payForService(quote: { price_usdc: string }): Promise<PayResult> {
  const tokenId = await getUsdcTokenId();

  let txRes;
  try {
    txRes = await client.createTransaction({
      walletId,
      destinationAddress,
      tokenId,
      amounts: [quote.price_usdc],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new CircleError(`createTransaction failed: ${msg}`, undefined, e);
  }

  const txId = txRes.data?.id;
  if (!txId) throw new CircleError("createTransaction returned no id");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const poll = await client.getTransaction({ id: txId });
    const tx = poll.data?.transaction;
    const state = tx?.state ?? "UNKNOWN";

    if (TERMINAL_OK.has(state)) {
      return { tx_id: txId, tx_hash: tx?.txHash ?? "", state };
    }
    if (TERMINAL_BAD.has(state)) {
      throw new CircleError(`transaction terminal ${state}`, state);
    }
  }
  throw new CircleError("transaction polling timeout (30s)");
}

export function getDestinationAddress(): string {
  return destinationAddress;
}
