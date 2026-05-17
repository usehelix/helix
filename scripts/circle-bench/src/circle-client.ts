import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { getChainConfig, type ChainConfig } from "./chain-config";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

const apiKey = requireEnv("CIRCLE_API_KEY");
const entitySecret = requireEnv("CIRCLE_ENTITY_SECRET");
const walletId = requireEnv("CIRCLE_WALLET_ID");
const destinationAddress = requireEnv("CIRCLE_SECOND_WALLET_ADDRESS");

// Chain configuration — defaults to arc-testnet. Override via CIRCLE_BENCH_CHAIN
// env or programmatically via setChain() before any pay call.
let activeChain: ChainConfig = getChainConfig(process.env.CIRCLE_BENCH_CHAIN);
export function setChain(chain: ChainConfig): void {
  activeChain = chain;
  cachedPayTokenId = null; // bust the cache when chain changes
}
export function getActiveChain(): ChainConfig {
  return activeChain;
}

const TERMINAL_OK = new Set(["CONFIRMED", "COMPLETE"]);
const TERMINAL_BAD = new Set(["FAILED", "DENIED", "CANCELLED"]);
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

let cachedPayTokenId: string | null = null;

async function getPayTokenId(): Promise<string> {
  if (cachedPayTokenId) return cachedPayTokenId;
  const balRes = await client.getWalletTokenBalance({ id: walletId });
  const balances = balRes.data?.tokenBalances ?? [];
  const tok = balances.find((b) => b.token?.symbol === activeChain.tokenSymbol);
  if (!tok?.token?.id) {
    throw new CircleError(
      `${activeChain.tokenSymbol} tokenId not found on source wallet for chain ${activeChain.name}`,
    );
  }
  cachedPayTokenId = tok.token.id;
  return cachedPayTokenId;
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
  const tokenId = await getPayTokenId();

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
