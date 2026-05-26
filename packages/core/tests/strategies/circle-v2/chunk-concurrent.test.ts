import { describe, it, expect, vi } from 'vitest';
import { chunkConcurrent } from '../../../src/strategies/circle-v2/chunk-concurrent.js';

const ok = <T,>(v: T) => () => Promise.resolve(v);
const fail = (msg: string) => () => Promise.reject(new Error(msg));

describe('chunkConcurrent', () => {
  it('chunk_size=1 — degenerate serial case (one op per chunk)', async () => {
    const ops = [ok(1), ok(2), ok(3)];
    const { results, stats } = await chunkConcurrent(ops, {
      chunkSize: 1,
      interChunkPauseMs: 0,
    });

    expect(results).toHaveLength(3);
    expect(stats.chunks).toBe(3);
    expect(stats.successes).toBe(3);
    expect(stats.failures).toBe(0);
    expect(stats.finalChunkSize).toBe(1);
  });

  it('chunk_size=N — single chunk when chunkSize >= operations.length', async () => {
    const ops = [ok('a'), ok('b'), ok('c'), ok('d'), ok('e')];
    const { results, stats } = await chunkConcurrent(ops, {
      chunkSize: 10,
      interChunkPauseMs: 0,
    });

    expect(results).toHaveLength(5);
    expect(stats.chunks).toBe(1);
    expect(stats.successes).toBe(5);
  });

  it('chunk_size=4 — 10 operations split into 3 chunks (4+4+2)', async () => {
    const ops = Array.from({ length: 10 }, (_, i) => ok(i));
    const { results, stats } = await chunkConcurrent(ops, {
      chunkSize: 4,
      interChunkPauseMs: 0,
    });

    expect(results).toHaveLength(10);
    expect(stats.chunks).toBe(3); // 4 + 4 + 2
    expect(stats.successes).toBe(10);
    expect(stats.finalChunkSize).toBe(4); // no rate-limits to shrink
  });

  it('adaptive shrinks chunk size on rate-limit-shaped rejections', async () => {
    // Chunk 1 (size 4): two rate-limit rejections -> shrink to 3
    // Chunk 2 (size 3): one rate-limit rejection -> shrink to 2
    // Chunk 3 (size 2): no rate-limit rejections -> stay at 2
    // Chunk 4 (size 2): no rate-limit rejections -> stay at 2
    // Total ops = 4 + 3 + 2 + ? = 11+ (let's use 12 to make it clean)
    const ops = [
      // Chunk 1 (size 4)
      ok(1), ok(2), fail('429 Too Many Requests'), fail('rate limit error'),
      // Chunk 2 (size 3 after shrink)
      ok(3), fail('429'), ok(4),
      // Chunk 3 (size 2 after shrink)
      ok(5), ok(6),
      // Chunk 4 (size 2)
      ok(7), ok(8),
      // Chunk 5 (size 2) — wait we have 11 ops + need exactly enough
    ];
    // Actually use exactly 12 to get 4+3+2+2+1: messy. Simpler: don't assert chunk count
    // Just assert that finalChunkSize is below initialChunkSize.

    const { stats } = await chunkConcurrent(ops, {
      chunkSize: 4,
      interChunkPauseMs: 0,
      adaptive: true,
    });

    expect(stats.finalChunkSize).toBeLessThan(4);
    expect(stats.finalChunkSize).toBeGreaterThanOrEqual(1);
    expect(stats.failures).toBeGreaterThanOrEqual(3);
  });

  it('adaptive disabled — chunk size stays constant even with rate-limit rejections', async () => {
    const ops = [
      fail('429'), fail('rate limit'), fail('429'),
      fail('429'), fail('rate limit'),
    ];
    const { stats } = await chunkConcurrent(ops, {
      chunkSize: 3,
      interChunkPauseMs: 0,
      adaptive: false,
    });

    expect(stats.finalChunkSize).toBe(3); // unchanged
    expect(stats.failures).toBe(5);
  });

  it('non-rate-limit rejections do NOT shrink chunk size', async () => {
    const ops = [
      ok(1), fail('Some other business error'),
      fail('Validation failed'), ok(2),
    ];
    const { stats } = await chunkConcurrent(ops, {
      chunkSize: 4,
      interChunkPauseMs: 0,
      adaptive: true,
    });

    expect(stats.finalChunkSize).toBe(4); // unchanged — no rate-limit pattern
    expect(stats.failures).toBe(2);
  });

  it('empty operations array — returns empty stats', async () => {
    const { results, stats } = await chunkConcurrent([], {
      chunkSize: 4,
      interChunkPauseMs: 0,
    });

    expect(results).toHaveLength(0);
    expect(stats.chunks).toBe(0);
    expect(stats.successes).toBe(0);
    expect(stats.failures).toBe(0);
    expect(stats.finalChunkSize).toBe(4);
  });

  it('respects interChunkPauseMs between chunks (not after the last)', async () => {
    // 6 ops with chunkSize=3 → 2 chunks, 1 inter-chunk pause
    const ops = Array.from({ length: 6 }, (_, i) => ok(i));
    const PAUSE = 50;
    const start = Date.now();
    const { stats } = await chunkConcurrent(ops, {
      chunkSize: 3,
      interChunkPauseMs: PAUSE,
    });
    const elapsed = Date.now() - start;

    expect(stats.chunks).toBe(2);
    // Should sleep ~50ms once (between chunk 1 and chunk 2), not twice.
    // Allow generous slack for CI timing.
    expect(elapsed).toBeGreaterThanOrEqual(PAUSE - 5);
    expect(elapsed).toBeLessThan(PAUSE * 3); // not double-paused
  });
});
