import { resolveAndEstimate, WindowState } from '../core/sliding-window-math';
import { AdapterCheckResult, SlidingWindowAdapter, WindowEntry } from '../core/types';

/**
 * In-process sliding-window adapter. Implements the exact same algorithm as the Redis
 * Lua script (adapters/lua/sliding-window.lua), so a single test suite (see
 * test/concurrency.test.ts and test/burst-comparison.test.ts) proves the algorithm for
 * both backends via this adapter, without needing a live Redis server.
 *
 * Atomicity note: `checkAndIncrement` is `async` (to satisfy the SlidingWindowAdapter
 * interface shared with the network-bound RedisAdapter) but its body contains no
 * `await`. Node.js runs synchronous code to completion before yielding to the next
 * queued microtask/callback, so two "concurrent" callers (e.g. via Promise.all) can
 * never interleave between this method's read and write of the same key — the
 * check-then-increment race that a naive two-round-trip Redis implementation would
 * have is structurally impossible here, mirroring what the Lua script gets from
 * Redis's own single-threaded command execution.
 */
export class MemoryAdapter implements SlidingWindowAdapter {
  private readonly store = new Map<string, WindowState>();
  private readonly expiresAt = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(sweepIntervalMs = 30_000) {
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  async checkAndIncrement(
    entries: WindowEntry[],
    nowMs: number,
    ttlSeconds: number,
  ): Promise<AdapterCheckResult> {
    const resolutions: { entry: WindowEntry; resolved: WindowState }[] = [];

    // Phase 1: read + resolve every hierarchy level, denying on the first that would
    // be exceeded. Nothing is written yet, so a denial leaves all counters untouched.
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const { estimate, resolved } = resolveAndEstimate(
        this.store.get(entry.redisKey),
        nowMs,
        entry.windowMs,
      );

      if (estimate + 1 > entry.limit) {
        return { allowed: false, deniedIndex: i + 1 };
      }
      resolutions.push({ entry, resolved });
    }

    // Phase 2: every level passed — commit all increments together.
    for (const { entry, resolved } of resolutions) {
      this.store.set(entry.redisKey, {
        windowStart: resolved.windowStart,
        currCount: resolved.currCount + 1,
        prevCount: resolved.prevCount,
      });
      this.expiresAt.set(entry.redisKey, nowMs + ttlSeconds * 1000);
    }

    return { allowed: true, deniedIndex: null };
  }

  /** Bounds memory by evicting counters idle past their TTL. */
  private sweep(): void {
    const now = Date.now();
    for (const [key, expiry] of this.expiresAt) {
      if (expiry <= now) {
        this.store.delete(key);
        this.expiresAt.delete(key);
      }
    }
  }

  size(): number {
    return this.store.size;
  }

  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }
}
