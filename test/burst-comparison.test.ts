import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory-adapter';
import { FixedWindowLimiter } from '../src/core/fixed-window-limiter';
import { WindowEntry } from '../src/core/types';

/**
 * Numeric demonstration of exactly the boundary-burst problem the sliding-window
 * counter was chosen to avoid (see sliding-window-math.ts doc comment).
 *
 * Setup: limit = 10 requests / 1000ms window. We send 10 requests just before a
 * fixed-window boundary and 10 more just after it — a 20-request burst inside a
 * ~20ms span, which should never be admitted in full by a limiter enforcing
 * "10 per rolling second".
 */
describe('fixed-window vs sliding-window burst behavior', () => {
  const LIMIT = 10;
  const WINDOW_MS = 1_000;

  it('fixed window admits up to ~2x the configured limit across a boundary', () => {
    const fixed = new FixedWindowLimiter(LIMIT, WINDOW_MS);
    const boundary = 10_000; // aligned window edge
    let admitted = 0;

    for (let i = 0; i < LIMIT; i++) {
      if (fixed.check('user', boundary - 10 + i)) admitted++; // just before the edge, prior window
    }
    for (let i = 0; i < LIMIT; i++) {
      if (fixed.check('user', boundary + i)) admitted++; // just after the edge, new window
    }

    // The classic failure: two full quotas land back-to-back because the counter
    // resets exactly at the boundary, regardless of how close together in real time
    // the two bursts were.
    expect(admitted).toBe(2 * LIMIT);
  });

  it('sliding window counter admits far fewer than 2x across the same boundary', async () => {
    const adapter = new MemoryAdapter(0);
    const entries: WindowEntry[] = [{ scope: 'key', redisKey: 'user', limit: LIMIT, windowMs: WINDOW_MS }];
    const boundary = 10_000;
    let admitted = 0;

    for (let i = 0; i < LIMIT; i++) {
      const r = await adapter.checkAndIncrement(entries, boundary - 10 + i, 60);
      if (r.allowed) admitted++;
    }
    for (let i = 0; i < LIMIT; i++) {
      const r = await adapter.checkAndIncrement(entries, boundary + i, 60);
      if (r.allowed) admitted++;
    }

    // At ~99% into the previous window when the second burst starts, the sliding
    // estimate carries over almost the full previous-window count, so the second
    // burst is admitted almost not at all — nowhere near the fixed window's 2x.
    expect(admitted).toBeLessThan(1.3 * LIMIT);
    expect(admitted).toBeGreaterThanOrEqual(LIMIT); // still honors the first burst fully

    // eslint-disable-next-line no-console
    console.log(
      `[burst comparison] limit=${LIMIT}/${WINDOW_MS}ms, 20-request burst across boundary -> ` +
        `fixed-window admitted 20/20, sliding-window admitted ${admitted}/20`,
    );
  });

  it('the approximation error stays small under steady, evenly spread traffic', async () => {
    // Sanity check on the "small approximation error" the spec calls out: with
    // requests spread evenly (the assumption the sliding estimate relies on), the
    // limiter should admit almost exactly `limit` per window, not meaningfully more.
    const adapter = new MemoryAdapter(0);
    const entries: WindowEntry[] = [{ scope: 'key', redisKey: 'steady', limit: 100, windowMs: WINDOW_MS }];
    let admitted = 0;
    const start = 1_000_000;
    const totalRequests = 300; // 3 windows worth, evenly spread
    const spacingMs = (3 * WINDOW_MS) / totalRequests;

    for (let i = 0; i < totalRequests; i++) {
      const r = await adapter.checkAndIncrement(entries, start + Math.round(i * spacingMs), 60);
      if (r.allowed) admitted++;
    }

    // Expect close to 300 admitted (3 windows * 100), i.e. low over-admission error
    // under the uniform-distribution assumption the algorithm relies on.
    expect(admitted).toBeGreaterThanOrEqual(295);
    expect(admitted).toBeLessThanOrEqual(300);
  });
});
