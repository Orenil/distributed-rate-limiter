import { fixedWindowCount } from './sliding-window-math';

/**
 * A plain fixed-window-counter limiter — the "naive" approach most off-the-shelf rate
 * limiters use. Kept here (not just inline in a test) so the burst-boundary comparison
 * in test/burst-comparison.test.ts exercises a real, independent implementation rather
 * than a duplicated stub, and so the failure mode it demonstrates is honestly attributable
 * to the algorithm rather than to sloppy test scaffolding.
 */
export class FixedWindowLimiter {
  private readonly store = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Returns true if the request is admitted under a plain fixed window. */
  check(key: string, now: number): boolean {
    const { count, windowStart } = fixedWindowCount(this.store.get(key), now, this.windowMs);
    if (count + 1 > this.limit) {
      return false;
    }
    this.store.set(key, { windowStart, count: count + 1 });
    return true;
  }
}
