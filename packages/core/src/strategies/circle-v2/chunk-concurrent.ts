/**
 * @file chunk-concurrent.ts
 * @description v2 strategy for `wallets-api-rate-limit`.
 *
 * Splits N operations into chunks of `chunkSize`, runs each chunk in parallel
 * via `Promise.allSettled`, and pauses `interChunkPauseMs` between chunks.
 * When `adaptive` is enabled, the chunk size shrinks by 1 (down to a floor
 * of 1) whenever a chunk produces a rate-limit-shaped rejection.
 *
 * Compared to v1 `serialize_and_backoff` (which forces strict serialization
 * with 2s backoff per failure), this strategy aims for 5–10× throughput at
 * the cost of slightly higher transient 429 rates that the adaptive shrink
 * absorbs.
 *
 * STANDALONE — not integrated into the PCEC engine. Bench scripts call this
 * function directly. Gene Map integration is a separate PR.
 */

export interface ChunkConcurrentOptions {
  /** Initial parallelism per chunk. Default 4. */
  chunkSize?: number;
  /** Pause between chunks in ms. Default 1500. */
  interChunkPauseMs?: number;
  /** If true, shrink chunk size on rate-limit-shaped rejections. Default true. */
  adaptive?: boolean;
}

export interface ChunkConcurrentStats {
  totalMs: number;
  chunks: number;
  successes: number;
  failures: number;
  /** The chunk size at the end of the run (relevant for adaptive mode). */
  finalChunkSize: number;
}

export interface ChunkConcurrentResult<T> {
  results: PromiseSettledResult<T>[];
  stats: ChunkConcurrentStats;
}

/**
 * Detect whether a rejection reason looks like a rate-limit error.
 * Matches "rate limit", "rate-limit", "429", or Circle's `code: 5`.
 */
function isRateLimitRejection(reason: unknown): boolean {
  const message = String((reason as { message?: string })?.message ?? reason ?? '');
  return /rate.?limit|429|code.*5/i.test(message);
}

export async function chunkConcurrent<T>(
  operations: ReadonlyArray<() => Promise<T>>,
  options: ChunkConcurrentOptions = {},
): Promise<ChunkConcurrentResult<T>> {
  const {
    chunkSize: initialChunkSize = 4,
    interChunkPauseMs = 1500,
    adaptive = true,
  } = options;

  const startTime = Date.now();
  const allResults: PromiseSettledResult<T>[] = [];
  let currentChunkSize = Math.max(1, initialChunkSize);
  let chunkCount = 0;
  let i = 0;

  while (i < operations.length) {
    const chunk = operations.slice(i, i + currentChunkSize);
    const chunkResults = await Promise.allSettled(chunk.map(op => op()));
    allResults.push(...chunkResults);
    chunkCount++;

    if (adaptive) {
      const rateLimitedCount = chunkResults.filter(
        r => r.status === 'rejected' && isRateLimitRejection(r.reason),
      ).length;
      if (rateLimitedCount > 0 && currentChunkSize > 1) {
        currentChunkSize = Math.max(1, currentChunkSize - 1);
      }
    }

    i += chunk.length;
    if (i < operations.length) {
      await new Promise(resolve => setTimeout(resolve, interChunkPauseMs));
    }
  }

  const successes = allResults.filter(r => r.status === 'fulfilled').length;

  return {
    results: allResults,
    stats: {
      totalMs: Date.now() - startTime,
      chunks: chunkCount,
      successes,
      failures: allResults.length - successes,
      finalChunkSize: currentChunkSize,
    },
  };
}
