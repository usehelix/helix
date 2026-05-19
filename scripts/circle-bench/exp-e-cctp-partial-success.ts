/**
 * CCTP Exp E: Partial Success — Agent Crash Between Burn and Mint
 *
 * Scenario:
 *   Agent burns 0.1 USDC on Arc Testnet (Step 1).
 *   Agent process exits before submitting the mint on Base Sepolia (Step 2).
 *   Without Helix: 0.1 USDC has left Arc, Base Sepolia never receives it —
 *   funds are effectively stuck (the attestation alone is not the asset; the
 *   mint must still be submitted by someone).
 *   With Helix: a pending-state record is persisted at burn time. On resume,
 *   Helix fetches the attestation from Circle's iris-api-sandbox and submits
 *   receiveMessage on Base Sepolia, completing the transfer.
 *
 * Gene capsule shape (informational):
 *   cctp-mint-incomplete → strategy: resume_pending_mint
 *   tracked state: { burn_tx, source_domain, dest_domain, dest_address }
 *
 * Modes:
 *   burn-only   — burn on Arc, persist state, simulate crash
 *   resume      — load state, poll attestation, submit mint on Base Sepolia
 *   full        — burn-only then resume in the same process (no real crash)
 *
 * Burn side: Circle Dev-Controlled Wallets API (the Arc wallet is custodied,
 * no raw private key exposed). Mint side: viem with CCTP_DEST_PRIVATE_KEY.
 *
 * Usage (from scripts/circle-bench/):
 *   npx tsx --env-file=.env exp-e-cctp-partial-success.ts burn-only
 *   npx tsx --env-file=.env exp-e-cctp-partial-success.ts resume
 *   npx tsx --env-file=.env exp-e-cctp-partial-success.ts full
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  defineChain,
  pad,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Chains ----------
const arcTestnet = defineChain({
  id: 26,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
});

// ---------- CCTP V2 constants ----------
const ARC_DOMAIN = 26 as const;
const BASE_SEPOLIA_DOMAIN = 6 as const;
const FINALITY_FAST = 1000 as const; // V2 Fast Transfer

const ARC_TOKEN_MESSENGER = process.env.ARC_TOKEN_MESSENGER as Hex;
const BASE_MESSAGE_TRANSMITTER = process.env.BASE_MESSAGE_TRANSMITTER as Hex;
const USDC_ARC = '0x3600000000000000000000000000000000000000' as Hex; // native USDC ERC-20 iface

// ---------- Burn parameters ----------
const BURN_AMOUNT = parseUnits('0.1', 6); // 0.1 USDC
const MAX_FEE = BURN_AMOUNT - 1n;          // allow up to 0.099 USDC fee (dust)
const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

// ---------- Paths ----------
const STATE_FILE = path.resolve(
  __dirname,
  '../../experiment-results/cctp-pending-state.json'
);
const RESULTS_DIR = path.resolve(__dirname, '../../experiment-results');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ---------- ABIs (minimal) ----------
const erc20ApproveAbi = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const tokenMessengerV2Abi = [
  {
    name: 'depositForBurn',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
    ],
    outputs: [],
  },
] as const;

const messageTransmitterAbi = [
  {
    name: 'receiveMessage',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

// ---------- Types ----------
type PendingState = {
  status: 'burn_complete_mint_pending' | 'complete';
  burn_tx: Hex;
  burn_timestamp: string;
  source_chain: 'arc-testnet';
  source_domain: number;
  dest_chain: 'base-sepolia';
  dest_domain: number;
  amount_usdc: string;
  dest_address: Hex;
  message?: Hex;
  attestation?: Hex;
  mint_tx?: Hex;
  mint_timestamp?: string;
  resume_started_at?: string;
  crash_duration_s?: number;     // user-controlled gap: resume_start - burn_timestamp
  recovery_latency_s?: number;   // actual Helix work: mint_timestamp - resume_start
  helix_resumed?: boolean;
};

// ============================================================
// Circle Dev-Controlled Wallets — poll helper
// ============================================================
const CIRCLE_POLL_INTERVAL_MS = 3000;
const CIRCLE_POLL_TIMEOUT_MS = 5 * 60 * 1000;

async function pollCircleTx(
  client: any,
  txId: string
): Promise<{ hash: Hex; state: string }> {
  const deadline = Date.now() + CIRCLE_POLL_TIMEOUT_MS;
  let lastState = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, CIRCLE_POLL_INTERVAL_MS));
    const r = await client.getTransaction({ id: txId });
    const t = r.data?.transaction;
    const state = t?.state ?? 'UNKNOWN';
    if (state !== lastState) {
      process.stdout.write(`\n    Circle tx state: ${state}`);
      lastState = state;
    }
    if (state === 'COMPLETE' || state === 'CONFIRMED') {
      if (!t?.txHash) throw new Error(`tx ${txId} ${state} but no txHash`);
      return { hash: t.txHash as Hex, state };
    }
    if (state === 'FAILED' || state === 'DENIED' || state === 'CANCELLED') {
      throw new Error(`Circle tx terminal ${state}: ${t?.errorReason ?? 'unknown'}`);
    }
  }
  throw new Error(`Circle tx ${txId} polling timeout after ${CIRCLE_POLL_TIMEOUT_MS / 1000}s`);
}

// ============================================================
// PHASE 1: BURN on Arc Testnet (via Circle Dev-Controlled Wallet)
// ============================================================
async function executeBurn(): Promise<PendingState> {
  if (!process.env.CIRCLE_API_KEY) throw new Error('Missing CIRCLE_API_KEY');
  if (!process.env.CIRCLE_ENTITY_SECRET) throw new Error('Missing CIRCLE_ENTITY_SECRET');
  if (!process.env.CIRCLE_WALLET_ID) throw new Error('Missing CIRCLE_WALLET_ID');
  if (!process.env.CIRCLE_WALLET_ADDRESS) throw new Error('Missing CIRCLE_WALLET_ADDRESS');
  if (!process.env.CCTP_DEST_ADDRESS) throw new Error('Missing CCTP_DEST_ADDRESS');
  if (!ARC_TOKEN_MESSENGER) throw new Error('Missing ARC_TOKEN_MESSENGER');

  const circleClient = initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET,
  });
  const walletId = process.env.CIRCLE_WALLET_ID;
  const sourceAddress = process.env.CIRCLE_WALLET_ADDRESS as Hex;
  const destAddress = process.env.CCTP_DEST_ADDRESS as Hex;
  const arcPublic = createPublicClient({ chain: arcTestnet, transport: http() });

  console.log('\n=== PHASE 1: BURN on Arc Testnet (via Circle Dev-Controlled Wallet) ===');
  console.log(`Source: ${sourceAddress} (Circle walletId ${walletId.slice(0, 8)}…)`);
  console.log(`Dest:   ${destAddress} (Base Sepolia, domain ${BASE_SEPOLIA_DOMAIN})`);
  console.log(`Amount: 0.1 USDC  |  maxFee: ${formatUnits(MAX_FEE, 6)} USDC  |  finality: ${FINALITY_FAST} (Fast)`);

  const balBefore = await arcPublic.readContract({
    address: USDC_ARC, abi: erc20ApproveAbi, functionName: 'balanceOf', args: [sourceAddress],
  });
  console.log(`Arc USDC balance before: ${formatUnits(balBefore, 6)}`);

  // --- 1) approve(TokenMessenger, BURN_AMOUNT) ---
  console.log('\nApproving TokenMessenger via Circle...');
  const approveRes = await circleClient.createContractExecutionTransaction({
    walletId,
    contractAddress: USDC_ARC,
    abiFunctionSignature: 'approve(address,uint256)',
    abiParameters: [ARC_TOKEN_MESSENGER, BURN_AMOUNT.toString()],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  const approveTxId = approveRes.data?.id;
  if (!approveTxId) throw new Error('Circle returned no tx id for approve');
  console.log(`  Circle txId: ${approveTxId}`);
  const approveResult = await pollCircleTx(circleClient, approveTxId);
  console.log(`\n  approve tx hash: ${approveResult.hash}`);

  // --- 2) depositForBurn V2 (Fast Transfer) ---
  // NOTE: minFinalityThreshold is uint32 in V2 (corrected from the original spec).
  const mintRecipient = pad(destAddress, { size: 32 });
  console.log('\nCalling depositForBurn (V2 Fast Transfer) via Circle...');
  const burnRes = await circleClient.createContractExecutionTransaction({
    walletId,
    contractAddress: ARC_TOKEN_MESSENGER,
    abiFunctionSignature:
      'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
    abiParameters: [
      BURN_AMOUNT.toString(),
      BASE_SEPOLIA_DOMAIN.toString(),
      mintRecipient,
      USDC_ARC,
      ZERO_BYTES32,
      MAX_FEE.toString(),
      FINALITY_FAST.toString(),
    ],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  const burnTxId = burnRes.data?.id;
  if (!burnTxId) throw new Error('Circle returned no tx id for burn');
  console.log(`  Circle txId: ${burnTxId}`);
  const burnResult = await pollCircleTx(circleClient, burnTxId);

  console.log(`\n✅ BURN SUCCESS`);
  console.log(`Burn TX: ${burnResult.hash}`);
  console.log(`Arc explorer: https://testnet.arcscan.app/tx/${burnResult.hash}`);

  const state: PendingState = {
    status: 'burn_complete_mint_pending',
    burn_tx: burnResult.hash,
    burn_timestamp: new Date().toISOString(),
    source_chain: 'arc-testnet',
    source_domain: ARC_DOMAIN,
    dest_chain: 'base-sepolia',
    dest_domain: BASE_SEPOLIA_DOMAIN,
    amount_usdc: '0.1',
    dest_address: destAddress,
  };
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`\n💾 Pending state saved: ${STATE_FILE}`);
  return state;
}

function simulateCrash() {
  console.log('\n⚠️  === SIMULATING AGENT CRASH ===');
  console.log('  Agent process exits after burn, before mint.');
  console.log('  0.1 USDC has left Arc Testnet.');
  console.log('  Base Sepolia has NOT received the USDC yet.');
  console.log('  Without Helix: funds stuck until someone replays the mint.');
  console.log('  With Helix: pending state recorded — recoverable on restart.');
}

// ============================================================
// PHASE 2: HELIX RESUMES the MINT on Base Sepolia
// ============================================================
async function helixResumeMint(state: PendingState): Promise<PendingState> {
  if (!process.env.CCTP_DEST_PRIVATE_KEY) throw new Error('Missing CCTP_DEST_PRIVATE_KEY');
  if (!BASE_MESSAGE_TRANSMITTER) throw new Error('Missing BASE_MESSAGE_TRANSMITTER');

  const resumeStart = new Date();

  console.log('\n=== HELIX PHASE 2: RESUME MINT on Base Sepolia ===');
  console.log('Gene Map match: cctp-mint-incomplete  →  strategy: resume_pending_mint');
  console.log(`Burn TX (Arc): ${state.burn_tx}`);

  // Poll Circle iris-api-sandbox V2 for the attestation
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${state.source_domain}?transactionHash=${state.burn_tx}`;
  console.log(`\nPolling attestation: ${url}`);

  let attestation: Hex | undefined;
  let message: Hex | undefined;
  const maxAttempts = 60; // 60 * 5s = 5 min cap
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data: any = await res.json();
        const msg = data.messages?.[0];
        if (msg?.status === 'complete' && msg.attestation && msg.message) {
          attestation = msg.attestation as Hex;
          message = msg.message as Hex;
          console.log(`\n✅ Attestation received after ${attempt} attempt(s) (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
          break;
        }
        process.stdout.write(`  attempt ${attempt}: status=${msg?.status ?? 'pending'}\r`);
      } else {
        process.stdout.write(`  attempt ${attempt}: HTTP ${res.status}\r`);
      }
    } catch (e: any) {
      process.stdout.write(`  attempt ${attempt}: ${e.message}\r`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!attestation || !message) {
    throw new Error(`Attestation not available after ${maxAttempts} attempts (~5min)`);
  }

  // Submit receiveMessage on Base Sepolia
  const destAccount = privateKeyToAccount(process.env.CCTP_DEST_PRIVATE_KEY as Hex);
  const baseWallet = createWalletClient({ account: destAccount, chain: baseSepolia, transport: http() });
  const basePublic = createPublicClient({ chain: baseSepolia, transport: http() });

  console.log('\nSubmitting receiveMessage to Base Sepolia MessageTransmitter...');
  const mintTx = await baseWallet.writeContract({
    address: BASE_MESSAGE_TRANSMITTER,
    abi: messageTransmitterAbi,
    functionName: 'receiveMessage',
    args: [message, attestation],
  });
  await basePublic.waitForTransactionReceipt({ hash: mintTx });

  console.log(`\n✅ MINT SUCCESS`);
  console.log(`Mint TX: ${mintTx}`);
  console.log(`Base Sepolia explorer: https://sepolia.basescan.org/tx/${mintTx}`);

  const mintTimestamp = new Date();
  const finalState: PendingState = {
    ...state,
    status: 'complete',
    message,
    attestation,
    mint_tx: mintTx,
    mint_timestamp: mintTimestamp.toISOString(),
    resume_started_at: resumeStart.toISOString(),
    crash_duration_s:
      (resumeStart.getTime() - new Date(state.burn_timestamp).getTime()) / 1000,
    recovery_latency_s: (mintTimestamp.getTime() - resumeStart.getTime()) / 1000,
    helix_resumed: true,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2));
  return finalState;
}

function printSummary(state: PendingState) {
  if (!state.mint_tx) return;
  console.log('\n' + '='.repeat(60));
  console.log('CCTP PARTIAL SUCCESS — HELIX RECOVERY');
  console.log('='.repeat(60));
  console.log(`Burn TX  (Arc):       ${state.burn_tx}`);
  console.log(`Mint TX  (Base):      ${state.mint_tx}`);
  if (state.crash_duration_s !== undefined)
    console.log(`Crash duration:       ${state.crash_duration_s.toFixed(1)}s  (burn → resume start)`);
  if (state.recovery_latency_s !== undefined)
    console.log(`Recovery latency:     ${state.recovery_latency_s.toFixed(1)}s  (resume start → mint)`);
  console.log(`Without Helix:        funds stuck (mint never submitted)`);
  console.log(`With Helix:           auto-resumed, 0.1 USDC delivered`);
  console.log('='.repeat(60));
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  const mode = (process.argv[2] ?? 'full') as 'burn-only' | 'resume' | 'full';

  if (mode === 'burn-only') {
    await executeBurn();
    simulateCrash();
    console.log('\nNext: run `npx tsx --env-file=.env exp-e-cctp-partial-success.ts resume`');
    return;
  }

  if (mode === 'resume') {
    if (!fs.existsSync(STATE_FILE)) {
      console.error(`No pending state at ${STATE_FILE}. Run burn-only first.`);
      process.exit(1);
    }
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as PendingState;
    if (state.status !== 'burn_complete_mint_pending') {
      console.error(`State.status = "${state.status}" — nothing to resume.`);
      process.exit(1);
    }
    const finalState = await helixResumeMint(state);
    printSummary(finalState);
    fs.writeFileSync(
      path.resolve(RESULTS_DIR, `exp-cctp-e-partial-success-${TIMESTAMP}.json`),
      JSON.stringify(finalState, null, 2)
    );
    return;
  }

  if (mode === 'full') {
    const state = await executeBurn();
    simulateCrash();
    console.log('\n(simulated — same process continues into resume)\n');
    const finalState = await helixResumeMint(state);
    printSummary(finalState);
    fs.writeFileSync(
      path.resolve(RESULTS_DIR, `exp-cctp-e-partial-success-${TIMESTAMP}.json`),
      JSON.stringify(finalState, null, 2)
    );
    return;
  }

  console.error(`Unknown mode: ${mode}. Use burn-only | resume | full.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('\n❌ FAILED:', err);
  process.exit(1);
});
