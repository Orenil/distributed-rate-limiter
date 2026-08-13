/**
 * Sliding-window-counter math, shared (conceptually) by the in-memory adapter and the
 * Redis Lua script (adapters/lua/sliding-window.lua) — the two must stay in lock-step.
 *
 * Why this algorithm and not the alternatives:
 *  - Fixed window (reset counter every windowMs): O(1) memory, but allows up to 2x the
 *    configured limit in a short burst straddling a window boundary. See
 *    test/burst-comparison.test.ts for a numeric demonstration.
 *  - Sliding log (store every request timestamp, count how many fall in the trailing
 *    window): exact, no approximation error, but memory grows with request volume per
 *    key, which is unbounded under sustained traffic and expensive to keep in Redis.
 *  - Sliding window counter (this file): O(1) memory per key (two counters + a window
 *    start marker), and approximates the sliding count by linearly weighting the
 *    previous window's count by how much of it is still "in view". The approximation
 *    assumes requests are uniformly distributed within the previous window, which is
 *    not always true, but the resulting error is bounded and small in practice — see
 *    the accuracy assertions in test/burst-comparison.test.ts.
 */

export interface WindowState {
  /** Epoch-ms start of the window this state's `currCount` belongs to. */
  windowStart: number;
  currCount: number;
  prevCount: number;
}

export interface EstimateResult {
  /** Estimated sliding count of requests already admitted, before considering this one. */
  estimate: number;
  /** The resolved state as of `now`, ready to be committed with `currCount + 1` if allowed. */
  resolved: WindowState;
}

/**
 * Resolve a possibly-stale stored window state against `now`, shifting curr -> prev
 * when the fixed window has rolled over, and compute the sliding-window estimate.
 *
 * This function is pure and synchronous by design: the in-memory adapter calls it
 * with no `await` between read and write, so a single Node.js event-loop turn commits
 * the whole check-then-increment atomically without needing a mutex.
 */
export function resolveAndEstimate(
  stored: WindowState | undefined,
  now: number,
  windowMs: number,
): EstimateResult {
  const curWindowStart = Math.floor(now / windowMs) * windowMs;

  let currCount = 0;
  let prevCount = 0;

  if (stored) {
    if (stored.windowStart === curWindowStart) {
      currCount = stored.currCount;
      prevCount = stored.prevCount;
    } else if (stored.windowStart === curWindowStart - windowMs) {
      // Exactly one window elapsed: last window's current count becomes "previous".
      currCount = 0;
      prevCount = stored.currCount;
    }
    // Otherwise more than one window has elapsed since the last request: both
    // counters are stale and reset to zero (handled by the initialized defaults above).
  }

  const elapsedFraction = Math.max(0, (now - curWindowStart) / windowMs);
  const estimate = currCount + prevCount * (1 - elapsedFraction);

  return {
    estimate,
    resolved: { windowStart: curWindowStart, currCount, prevCount },
  };
}

/** Fixed-window-counter estimate, used only for the burst-comparison test. */
export function fixedWindowCount(
  stored: { windowStart: number; count: number } | undefined,
  now: number,
  windowMs: number,
): { count: number; windowStart: number } {
  const curWindowStart = Math.floor(now / windowMs) * windowMs;
  if (stored && stored.windowStart === curWindowStart) {
    return { count: stored.count, windowStart: curWindowStart };
  }
  return { count: 0, windowStart: curWindowStart };
}
