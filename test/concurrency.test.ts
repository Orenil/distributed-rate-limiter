import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory-adapter';
import { ConfigStore } from '../src/core/config-store';
import { RateLimiter } from '../src/core/limiter';
import { WindowEntry } from '../src/core/types';

/**
 * The spec's core correctness concern: under real concurrent load at the exact limit
 * boundary, does the hierarchical check ever over-admit? A naive "GET count, compare,
 * INCR" implementation (two round trips, no lock) would let multiple concurrent callers
 * all read the same "9 of 10 used" and all admit — this test proves that doesn't happen
 * here, at both the raw-adapter layer and through the full RateLimiter/ConfigStore path.
 */
describe('concurrency at the limit boundary', () => {
  it('never admits more than the limit under many real concurrent adapter calls', async () => {
    const adapter = new MemoryAdapter(0);
    const limit = 50;
    const entries: WindowEntry[] = [{ scope: 'key', redisKey: 'boundary', limit, windowMs: 1_000 }];
    const now = 5_000_000;
    const attempts = 500;

    // Genuinely concurrent: all attempts are issued before any of them resolves.
    const results = await Promise.all(
      Array.from({ length: attempts }, () => adapter.checkAndIncrement(entries, now, 60)),
    );

    const admitted = results.filter((r) => r.allowed).length;
    expect(admitted).toBe(limit);
  });

  it('never over-admits across a hierarchy (key/tenant/global) under concurrent load', async () => {
    const adapter = new MemoryAdapter(0);
    const config = new ConfigStore([
      {
        route: 'api',
        failMode: 'closed',
        limits: [
          { scope: 'key', limit: 1_000, windowMs: 1_000 }, // effectively non-binding
          { scope: 'tenant', limit: 30, windowMs: 1_000 }, // the binding constraint
          { scope: 'global', limit: 1_000, windowMs: 1_000 },
        ],
      },
    ]);
    const limiter = new RateLimiter(adapter, config);

    const attempts = 400;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        limiter.check({ route: 'api', key: `user-${i}`, tenant: 'tenant-x' }),
      ),
    );

    const admitted = results.filter((r) => r.allowed).length;
    expect(admitted).toBe(30);
    expect(results.filter((r) => !r.allowed && r.deniedScope === 'tenant').length).toBe(attempts - 30);
  });

  it('simulates multiple gateway instances sharing one backend without over-admission', async () => {
    // Multiple "gateway instances" (RateLimiter instances) sharing the same adapter
    // instance, exactly as multiple Node processes would share one Redis instance.
    const sharedAdapter = new MemoryAdapter(0);
    const sharedConfig = new ConfigStore([
      { route: 'shared', failMode: 'closed', limits: [{ scope: 'global', limit: 25, windowMs: 1_000 }] },
    ]);
    const gateways = Array.from({ length: 5 }, () => new RateLimiter(sharedAdapter, sharedConfig));

    const calls = gateways.flatMap((gw, gi) =>
      Array.from({ length: 20 }, (_, i) => gw.check({ route: 'shared', key: `${gi}-${i}`, tenant: 't' })),
    );
    const results = await Promise.all(calls);

    expect(results.filter((r) => r.allowed).length).toBe(25);
  });
});
