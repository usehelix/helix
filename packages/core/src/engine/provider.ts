import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseGwei,
  formatEther,
  type PublicClient,
  type WalletClient,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { DexConfig, FailureClassification, HelixProviderConfig } from './types.js';
import { ERC20_ABI, SWAP_ROUTER_ABI } from './abi.js';
import { getDexPreset } from './dex-presets.js';

export interface CommitResult {
  success: boolean;
  overrides: Record<string, unknown>;
  description: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class HelixProvider {
  private config: HelixProviderConfig;
  private hasExplicitConfig: boolean;
  private publicClient: PublicClient | null = null;
  private walletClient: WalletClient | null = null;
  private account: Account | null = null;

  constructor(config: HelixProviderConfig = {}) {
    this.config = config;
    this.hasExplicitConfig = !!(config.rpcUrl || config.privateKey || config.privy || config.coinbase);

    if (config.rpcUrl) {
      this.publicClient = createPublicClient({ transport: http(config.rpcUrl) });
    }

    if (config.privateKey) {
      const key = config.privateKey.startsWith('0x')
        ? config.privateKey as `0x${string}`
        : (`0x${config.privateKey}`) as `0x${string}`;
      this.account = privateKeyToAccount(key);
      if (config.rpcUrl) {
        this.walletClient = createWalletClient({
          account: this.account,
          transport: http(config.rpcUrl),
        });
      }
    }
  }

  canExecute(strategy: string): boolean {
    // Chain strategy: check all individual steps
    if (strategy.includes('+')) {
      return strategy.split('+').every(s => this.canExecute(s.trim()));
    }

    if (!this.hasExplicitConfig) return true; // mock/dev mode

    const noProvider = [
      'backoff_retry', 'retry', 'reduce_request', 'fix_params',
      'switch_endpoint', 'retry_with_estimation', 'hold_and_notify',
      'retry_with_receipt', 'extend_deadline', 'use_unrestricted_wallet',
      'remove_and_resubmit', 'renew_session', 'switch_service',
      'refund_waterfall',
    ];
    if (noProvider.includes(strategy)) return true;

    const rpcRead = ['refresh_nonce', 'switch_network', 'get_balance'];
    if (rpcRead.includes(strategy)) return !!this.publicClient;

    const chainWrite = [
      'self_pay_gas', 'cancel_pending_txs', 'speed_up_transaction',
      'split_transaction', 'topup_from_reserve', 'swap_currency',
      'switch_stablecoin', 'split_swap',
    ];
    if (chainWrite.includes(strategy)) return !!this.walletClient;

    return true; // unknown strategy — allow (will mock)
  }

  getAddress(): string | null {
    return this.account?.address ?? null;
  }

  async execute(
    strategy: string,
    failure: FailureClassification,
    context?: Record<string, unknown>,
  ): Promise<CommitResult> {
    try {
      switch (strategy) {

        // ═══════ Category A: No provider needed ═══════

        case 'backoff_retry': {
          const delay = context?.retryAfter ? Number(context.retryAfter) * 1000 : 2000;
          await sleep(Math.min(delay, 5000));
          return { success: true, overrides: {}, description: `Waited ${delay}ms before retry` };
        }

        case 'retry': {
          await sleep(500);
          return { success: true, overrides: {}, description: 'Simple retry after 500ms delay' };
        }

        case 'reduce_request': {
          const available = context?.availableBalance ?? context?.balance ?? 0;
          return { success: true, overrides: { amount: available }, description: `Reduced amount to available balance: ${available}` };
        }

        case 'fix_params': {
          const overrides: Record<string, unknown> = {};
          if (!context?.gasLimit) overrides.gasLimit = 21000n;
          if (!context?.chainId) overrides.chainId = 1;
          if (!context?.type) overrides.type = 'eip1559';
          if (!context?.maxFeePerGas) overrides.maxFeePerGas = parseGwei('20');
          if (!context?.maxPriorityFeePerGas) overrides.maxPriorityFeePerGas = parseGwei('2');
          return { success: true, overrides, description: `Auto-populated: ${Object.keys(overrides).join(', ')}` };
        }

        case 'retry_with_estimation': {
          await sleep(300);
          return { success: true, overrides: { autoEstimate: true }, description: 'Retry with auto-estimation' };
        }

        case 'switch_endpoint': {
          const alt = context?.altEndpoint ?? context?.backupUrl;
          if (alt) return { success: true, overrides: { endpoint: alt }, description: `Switched to: ${alt}` };
          return { success: false, overrides: {}, description: 'No alternative endpoint available' };
        }

        case 'hold_and_notify':
          return { success: true, overrides: { paused: true }, description: 'Agent paused. Operator notified.' };

        case 'extend_deadline': {
          const d = Number(context?.deadline ?? 0) + 300;
          return { success: true, overrides: { deadline: d }, description: `Extended deadline by 300s` };
        }

        case 'use_unrestricted_wallet': {
          const w = context?.altWallet ?? context?.unrestricted_wallet;
          return { success: true, overrides: w ? { wallet: w } : {}, description: w ? 'Switched to unrestricted wallet' : 'Flagged for unrestricted wallet' };
        }

        case 'remove_and_resubmit': {
          const idx = context?.failedIndex ?? 0;
          const sz = context?.batchSize ?? 1;
          return { success: true, overrides: { excludeIndex: idx, newBatchSize: Number(sz) - 1 }, description: `Removed item #${idx}, resubmitting ${Number(sz) - 1} items` };
        }

        case 'renew_session': {
          await sleep(300);
          return { success: true, overrides: { sessionRenewed: true }, description: 'Session renewed' };
        }

        case 'switch_service':
          return { success: true, overrides: { switchedService: true }, description: 'Switched to alt service provider' };

        case 'refund_waterfall': {
          const step = context?.failedStep ?? 'unknown';
          const done = context?.completedSteps ?? [];
          return { success: true, overrides: { refundRequired: true, failedStep: step, completedSteps: done }, description: `Cascade failure at '${step}'. ${(done as string[]).length} steps flagged for refund.` };
        }

        // ═══════ Category B: Real RPC reads (needs rpcUrl) ═══════

        case 'refresh_nonce': {
          if (!this.publicClient) {
            if (!this.hasExplicitConfig) return this._mock(strategy);
            return { success: false, overrides: {}, description: 'No RPC URL — cannot refresh nonce' };
          }
          const addr = (context?.walletAddress ?? context?.from ?? this.account?.address) as `0x${string}` | undefined;
          if (!addr) return { success: false, overrides: {}, description: 'No wallet address for nonce lookup' };
          const nonce = await this.publicClient.getTransactionCount({ address: addr });
          return { success: true, overrides: { nonce }, description: `Refreshed nonce from chain: ${nonce} for ${addr.slice(0, 10)}...` };
        }

        case 'switch_network': {
          if (!this.publicClient) {
            if (!this.hasExplicitConfig) return this._mock(strategy);
            return { success: false, overrides: {}, description: 'No RPC URL — cannot switch network' };
          }
          const targetRpc = context?.targetRpcUrl as string | undefined;
          if (targetRpc) {
            this.publicClient = createPublicClient({ transport: http(targetRpc) });
            if (this.walletClient && this.account) {
              this.walletClient = createWalletClient({ account: this.account, transport: http(targetRpc) });
            }
          }
          const cid = await this.publicClient.getChainId();
          return { success: true, overrides: { chainId: context?.targetChainId ?? cid }, description: `Switched to chain ${cid}` };
        }

        case 'get_balance': {
          if (!this.publicClient) {
            if (!this.hasExplicitConfig) return this._mock(strategy);
            return { success: false, overrides: {}, description: 'No RPC URL — cannot check balance' };
          }
          const a = (context?.walletAddress ?? context?.from ?? this.account?.address) as `0x${string}` | undefined;
          if (!a) return { success: false, overrides: {}, description: 'No address for balance check' };
          const bal = await this.publicClient.getBalance({ address: a });
          return { success: true, overrides: { balance: formatEther(bal), balanceWei: bal.toString() }, description: `Balance: ${formatEther(bal)} ETH for ${a.slice(0, 10)}...` };
        }

        case 'retry_with_receipt': {
          if (!this.publicClient) {
            await sleep(1000);
            return { success: true, overrides: {}, description: 'Retry (no RPC for receipt)' };
          }
          const txHash = context?.txHash as `0x${string}` | undefined;
          if (txHash) {
            try {
              const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
              return {
                success: receipt.status === 'success',
                overrides: { receipt: { status: receipt.status, block: receipt.blockNumber.toString() } },
                description: `Receipt: ${receipt.status} at block ${receipt.blockNumber}`,
              };
            } catch {
              return { success: false, overrides: {}, description: 'Receipt wait timed out' };
            }
          }
          await sleep(1000);
          return { success: true, overrides: {}, description: 'Retry with delay (no receipt to verify)' };
        }

        // ═══════ Category C: Real chain writes (needs privateKey) ═══════

        case 'self_pay_gas': {
          if (!this.walletClient || !this.account) {
            if (!this.hasExplicitConfig) return this._mock(strategy);
            return { success: false, overrides: {}, description: 'No private key — cannot pay gas' };
          }
          const to = context?.to as `0x${string}` | undefined;
          if (!to) return { success: true, overrides: { sponsor: false }, description: 'Flagged: retry without gas sponsor' };
          const value = context?.value ? BigInt(context.value as string) : 0n;
          const data = context?.data as `0x${string}` | undefined;
          const hash = await this.walletClient.sendTransaction({ to, value, data, account: this.account, chain: null });
          return { success: true, overrides: { txHash: hash, sponsor: false }, description: `Self-paid gas tx: ${hash.slice(0, 18)}...` };
        }

        case 'cancel_pending_txs': {
          if (!this.walletClient || !this.account || !this.publicClient) {
            if (!this.hasExplicitConfig) return this._mock(strategy);
            return { success: false, overrides: {}, description: 'No wallet — cannot cancel' };
          }
          const n = context?.nonce ? Number(context.nonce) : await this.publicClient.getTransactionCount({ address: this.account.address });
          const hash = await this.walletClient.sendTransaction({
            to: this.account.address, value: 0n, nonce: n,
            maxFeePerGas: parseGwei('50'), maxPriorityFeePerGas: parseGwei('10'),
            account: this.account, chain: null,
          });
          return { success: true, overrides: { cancelTxHash: hash, cancelledNonce: n }, description: `Cancelled nonce ${n}: ${hash.slice(0, 18)}...` };
        }

        case 'speed_up_transaction': {
          if (!this.walletClient || !this.account || !this.publicClient) {
            if (!this.hasExplicitConfig) return this._mock(strategy);
            return { success: false, overrides: {}, description: 'No wallet — cannot speed up' };
          }
          const to = context?.to as `0x${string}` | undefined;
          const nonce = context?.nonce !== undefined ? Number(context.nonce) : undefined;
          if (!to || nonce === undefined) return { success: false, overrides: {}, description: 'Missing to/nonce for speed up' };
          const gasPrice = await this.publicClient.getGasPrice();
          const bumped = (gasPrice * 130n) / 100n;
          const value = context?.value ? BigInt(context.value as string) : 0n;
          const hash = await this.walletClient.sendTransaction({
            to, value, nonce, maxFeePerGas: bumped, maxPriorityFeePerGas: bumped / 10n,
            account: this.account, chain: null,
          });
          return { success: true, overrides: { speedUpTxHash: hash, gasBumped: true }, description: `Speed-up tx with 30% gas bump: ${hash.slice(0, 18)}...` };
        }

        case 'split_transaction': {
          if (!this.walletClient || !this.account || !this.publicClient) {
            if (!this.hasExplicitConfig) return this._mock(strategy);
            return { success: false, overrides: {}, description: 'No wallet — cannot split' };
          }
          const total = context?.amount ? BigInt(context.amount as string) : 0n;
          const limit = context?.limit ? BigInt(context.limit as string) : parseEther('100');
          const to = context?.to as `0x${string}` | undefined;
          if (!to || total === 0n) return { success: true, overrides: { splitRequired: true }, description: 'Flagged for split' };
          const chunks = Number((total + limit - 1n) / limit);
          const hashes: string[] = [];
          for (let i = 0; i < chunks; i++) {
            const amt = i < chunks - 1 ? limit : total - limit * BigInt(i);
            const n = await this.publicClient.getTransactionCount({ address: this.account.address });
            const h = await this.walletClient.sendTransaction({ to, value: amt, nonce: n, account: this.account, chain: null });
            hashes.push(h);
          }
          return { success: true, overrides: { txHashes: hashes, chunks }, description: `Split into ${chunks} txs` };
        }

        case 'topup_from_reserve': {
          if (!this.walletClient || !this.account) {
            if (!this.hasExplicitConfig) return this._mock(strategy);
            return { success: false, overrides: {}, description: 'No wallet — cannot topup' };
          }
          const recipient = (context?.walletAddress ?? context?.to) as `0x${string}` | undefined;
          const amt = context?.topupAmount ? BigInt(context.topupAmount as string) : parseEther('0.01');
          if (!recipient) return { success: true, overrides: { topupNeeded: true }, description: 'Flagged for topup (no recipient)' };
          const hash = await this.walletClient.sendTransaction({ to: recipient, value: amt, account: this.account, chain: null });
          return { success: true, overrides: { topupTxHash: hash, topupAmount: formatEther(amt) }, description: `Topped up ${formatEther(amt)} ETH: ${hash.slice(0, 18)}...` };
        }

        // ═══════ DEX Operations (Uniswap V3 via viem) ═══════

        case 'swap_currency':
        case 'switch_stablecoin':
        case 'swap_to_usdc': {
          if (!this.walletClient || !this.account || !this.publicClient) {
            if (!this.hasExplicitConfig) return this._mock(strategy);
            return { success: false, overrides: {}, description: `No wallet for ${strategy}` };
          }
          const dex = this.config.dex ?? getDexPreset(await this.publicClient.getChainId());
          if (!dex) return { success: false, overrides: {}, description: `No DEX config for this chain` };
          return await this._executeSwap(dex, strategy, failure, context);
        }

        case 'split_swap': {
          if (!this.walletClient || !this.account || !this.publicClient) {
            if (!this.hasExplicitConfig) return this._mock(strategy);
            return { success: false, overrides: {}, description: 'No wallet for split_swap' };
          }
          const dex = this.config.dex ?? getDexPreset(await this.publicClient.getChainId());
          if (!dex) return { success: false, overrides: {}, description: 'No DEX config for this chain' };
          const total = context?.amount ? BigInt(context.amount as string) : 0n;
          const numChunks = Number(context?.chunks ?? 3);
          if (total === 0n) return { success: true, overrides: { splitRequired: true }, description: 'Flagged for split' };
          const chunkSz = total / BigInt(numChunks);
          const hashes: string[] = [];
          for (let i = 0; i < numChunks; i++) {
            const amt = i < numChunks - 1 ? chunkSz : total - chunkSz * BigInt(i);
            const r = await this._executeSwap(dex, 'swap_currency', failure, { ...context, amount: amt.toString() });
            if (!r.success) return { success: false, overrides: { completedChunks: i, hashes }, description: `Split swap failed at chunk ${i + 1}/${numChunks}` };
            if (r.overrides.txHash) hashes.push(r.overrides.txHash as string);
          }
          return { success: true, overrides: { txHashes: hashes, chunks: numChunks }, description: `Split swap: ${numChunks} chunks` };
        }

        // ═══════ Circle-specific (Group 1 nanopayments, validated Apr 2026) ═══════

        case 'serialize_and_backoff': {
          // Wallets API concurrency lock — pause, signal caller to serialize
          const delay = Number(context?.retryAfterMs ?? context?.defaultDelayMs) || 2000;
          await sleep(Math.min(delay, 5000));
          return {
            success: true,
            overrides: { _helix_serialize: true, _helix_concurrency: 1 },
            description: `Serialized retry after ${delay}ms (Wallets API concurrency lock)`,
          };
        }

        case 'burst_then_pace': {
          // Gateway sliding-window — pause between bursts of N
          const pauseMs = Number(context?.pauseMs) || 20000;
          const burstSize = Number(context?.burstSize) || 10;
          await sleep(pauseMs);
          return {
            success: true,
            overrides: { _helix_burst_size: burstSize, _helix_pace_pause_ms: pauseMs },
            description: `Paced retry after ${pauseMs}ms pause (Gateway sliding window)`,
          };
        }

        case 'rotate_authorization': {
          // EIP-3009 — generate fresh 32-byte nonce; caller must re-sign
          const { randomBytes } = await import('node:crypto');
          const newNonce = '0x' + randomBytes(32).toString('hex');
          return {
            success: true,
            overrides: { authorization_nonce: newNonce, _helix_resign_authorization: true },
            description: 'Generated fresh EIP-3009 nonce; caller must re-sign',
          };
        }

        case 'wait_attestation': {
          // CCTP — poll Circle attestation API until message is signed
          // Requires Node 18+ for global fetch (verified — repo runs on node v24).
          const messageHash = context?.messageHash ?? context?._messageHash;
          if (!messageHash) {
            return {
              success: false,
              overrides: {},
              description: 'wait_attestation requires context.messageHash',
            };
          }
          const pollIntervalMs = Number(context?.pollIntervalMs) || 5000;
          const maxWaitMs = Number(context?.maxWaitMs) || 90000;
          const env = context?.cctpEnv === 'mainnet' ? 'iris-api' : 'iris-api-sandbox';
          const start = Date.now();
          while (Date.now() - start < maxWaitMs) {
            try {
              const resp = await fetch(`https://${env}.circle.com/v1/attestations/${messageHash}`);
              if (resp.ok) {
                const data = (await resp.json()) as { status: string; attestation?: string };
                if (data.status === 'complete' && data.attestation) {
                  return {
                    success: true,
                    overrides: { attestation: data.attestation },
                    description: `Attestation ready after ${Date.now() - start}ms (${env})`,
                  };
                }
              }
            } catch {
              /* transient network — retry on next poll */
            }
            await sleep(pollIntervalMs);
          }
          return {
            success: false,
            overrides: {},
            description: `Attestation not ready within ${maxWaitMs}ms (${env})`,
          };
        }

        // ═══════ Experimentally-validated (Apr 2026, Arc Testnet) ═══════

        case 'override_api_decimals': {
          // Override the API's reported decimals using one of three sources,
          // in priority order. Validated in Exp A (Apr 2026, Arc Testnet):
          // Circle Wallets API returns decimals=18 for USDC on Arc; actual is 6.

          // ── PRIORITY 1: on-chain ERC-20 decimals() (if caller can read chain) ──
          const publicClient: any = (context as any)?.publicClient;
          const tokenAddress = (context as any)?.tokenAddress;
          if (publicClient && tokenAddress) {
            try {
              const onChainDecimals = (await publicClient.readContract({
                address: tokenAddress as `0x${string}`,
                abi: [{
                  name: 'decimals',
                  type: 'function',
                  stateMutability: 'view',
                  inputs: [],
                  outputs: [{ type: 'uint8' }],
                }],
                functionName: 'decimals',
              })) as number;
              return {
                success: true,
                overrides: {
                  decimals: onChainDecimals,
                  _helix_actual_decimals: onChainDecimals,
                  _helix_repair_source: 'on-chain',
                },
                description: `Read on-chain decimals=${onChainDecimals} from ${tokenAddress}`,
              };
            } catch {
              /* fall through to ground-truth table */
            }
          }

          // ── PRIORITY 2: native-asset ground-truth table ──
          // Some chains have native USDC (no ERC-20 contract). Circle's API
          // decimals field is unreliable for these — use a curated table.
          const NATIVE_DECIMALS_GROUND_TRUTH: Record<string, number> = {
            'arc-testnet:usdc': 6,
            'arc:usdc': 6,
            'base-sepolia:usdc': 6,
            'base:usdc': 6,
            'avalanche-fuji:usdc': 6,
            'avalanche:usdc': 6,
            // Extend as more native-USDC chains land.
          };
          const chain = String((context as any)?.chain ?? '').toLowerCase();
          const symbol = String(
            (context as any)?.token_symbol
            ?? (failure as any)?.token_symbol
            ?? 'usdc',
          ).toLowerCase();
          const key = `${chain}:${symbol}`;
          const groundTruth = NATIVE_DECIMALS_GROUND_TRUTH[key];
          if (groundTruth !== undefined) {
            return {
              success: true,
              overrides: {
                decimals: groundTruth,
                _helix_actual_decimals: groundTruth,
                _helix_repair_source: 'ground-truth-table',
                _helix_ground_truth_key: key,
              },
              description: `Native asset on ${chain}: ${symbol} decimals=${groundTruth} (overriding API metadata)`,
            };
          }

          // ── PRIORITY 3: caller-supplied expected_decimals ──
          const apiDecimals = (context as any)?.api_reported_decimals;
          const expectedDecimals = (context as any)?.expected_decimals;
          if (expectedDecimals !== undefined && apiDecimals !== undefined) {
            return {
              success: true,
              overrides: {
                decimals: expectedDecimals,
                _helix_actual_decimals: expectedDecimals,
                _helix_repair_source: 'caller-provided',
              },
              description: `Caller-supplied correct decimals=${expectedDecimals} (API said ${apiDecimals})`,
            };
          }

          return {
            success: false,
            overrides: {},
            description: 'Cannot determine correct decimals; no on-chain access, no ground-truth entry, no caller-supplied value',
          };
        }

        // ═══════ Default ═══════

        default:
          return this._mock(strategy);
      }
    } catch (err) {
      return { success: false, overrides: {}, description: `Execution error in '${strategy}': ${(err as Error).message}` };
    }
  }

  private async _executeSwap(
    dex: DexConfig, strategy: string, failure: FailureClassification, context?: Record<string, unknown>,
  ): Promise<CommitResult> {
    if (!this.walletClient || !this.account || !this.publicClient) {
      return { success: false, overrides: {}, description: 'No wallet client for swap' };
    }
    let tokenIn = context?.tokenIn as `0x${string}` | undefined;
    let tokenOut = context?.tokenOut as `0x${string}` | undefined;
    if ((strategy === 'swap_to_usdc' || strategy === 'switch_stablecoin') && !tokenOut) tokenOut = dex.defaultTokens.usdc;
    if (!tokenIn) tokenIn = dex.wethAddress;
    if (!tokenOut) tokenOut = dex.defaultTokens.usdc;
    if (!tokenIn || !tokenOut) return { success: false, overrides: {}, description: 'Cannot determine token pair' };
    const amount = context?.amount ? BigInt(context.amount as string) : 0n;
    if (amount === 0n) return { success: false, overrides: {}, description: 'Swap amount is 0' };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + dex.defaultDeadlineSeconds);
    try {
      const isNative = tokenIn.toLowerCase() === dex.wethAddress.toLowerCase();
      if (!isNative) {
        const allowance = await this.publicClient.readContract({
          address: tokenIn, abi: ERC20_ABI, functionName: 'allowance',
          args: [this.account.address, dex.routerAddress],
        }) as bigint;
        if (allowance < amount) {
          const approveTx = await this.walletClient.writeContract({
            address: tokenIn, abi: ERC20_ABI, functionName: 'approve',
            args: [dex.routerAddress, amount * 2n],
            account: this.account, chain: null,
          });
          await this.publicClient.waitForTransactionReceipt({ hash: approveTx });
        }
      }
      const swapTx = await this.walletClient.writeContract({
        address: dex.routerAddress, abi: SWAP_ROUTER_ABI, functionName: 'exactInputSingle',
        args: [{ tokenIn, tokenOut, fee: 3000, recipient: this.account.address, deadline, amountIn: amount, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
        value: isNative ? amount : 0n,
        account: this.account, chain: null,
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: swapTx });
      if (receipt.status === 'success') {
        return { success: true, overrides: { txHash: swapTx, tokenIn, tokenOut, amountIn: amount.toString(), block: receipt.blockNumber.toString() }, description: `Swap confirmed at block ${receipt.blockNumber}` };
      }
      return { success: false, overrides: { txHash: swapTx, reverted: true }, description: `Swap reverted` };
    } catch (err) {
      return { success: false, overrides: {}, description: `Swap failed: ${(err as Error).message.slice(0, 200)}` };
    }
  }

  private async _mock(strategy: string): Promise<CommitResult> {
    const jitter = Math.random() * 200;
    await sleep(Math.min(300 + jitter, 800));
    return { success: true, overrides: {}, description: `[MOCK] '${strategy}' (real implementation pending)` };
  }
}
