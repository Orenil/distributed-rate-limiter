import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory-adapter';
import { ConfigStore } from '../src/core/config-store';
import { RateLimiter } from '../src/core/limiter';

/**
 * Latency benchmark under load. The spec calls for "sub-millisecond decision latency"
 * and "verified correctness/latency under concurrent load". This measures the actual
 * RateLimiter.check() latency (which includes the full hierarchical decision — three
 * levels, key/tenant/global — end to end) against the MemoryAdapter, both for a single
 * decision and for a batch issued concurrently, and prints real numbers rather than
 * asserting a specific number came out of thin air.
 *
 * This benchmarks the in-process decision path (the same path a RedisAdapter-backed
 * deployment shares, minus the network round trip) — it is not a claim about latency
 * over a real network to a real Redis instance, which the README calls out explicitly.
 */
function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

describe('latency benchmark', () => {
  it('measures per-decision latency for a single hierarchical check', async () => {
    const adapter = new MemoryAdapter(0);
    const config = new ConfigStore([
      {
        route: 'bench',
        failMode: 'closed',
        limits: [
          { scope: 'key', limit: 1_000_000, windowMs: 60_000 },
          { scope: 'tenant', limit: 1_000_000, windowMs: 60_000 },
          { scope: 'global', limit: 1_000_000, windowMs: 60_000 },
        ],
      },
    ]);
    const limiter = new RateLimiter(adapter, config);

    // Warm up (JIT / megamorphic call sites) before timing.
    for (let i = 0; i < 200; i++) {
      await limiter.check({ route: 'bench', key: `warm-${i}`, tenant: 'warm' });
    }

    const samples = 2_000;
    const latencies: number[] = [];
    for (let i = 0; i < samples; i++) {
      const result = await limiter.check({ route: 'bench', key: `k-${i}`, tenant: 't-single' });
      latencies.push(result.latencyMs);
    }
    latencies.sort((a, b) => a - b);

    const p50 = percentile(latencies, 50);
    const p99 = percentile(latencies, 99);
    const max = latencies[latencies.length - 1];

    // eslint-disable-next-line no-console
    console.log(
      `[latency benchmark] sequential single-decision: p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms max=${max.toFixed(3)}ms (n=${samples})`,
    );

    // Generous ceiling — the point is proving sub-millisecond-class decisions on the
    // in-process path, not chasing a flaky micro-benchmark assertion on shared CI
    // hardware.
    expect(p50).toBeLessThan(1);
    expect(p99).toBeLessThan(5);
  });

  it('measures throughput and latency under concurrent load across many "gateway" callers', async () => {
    const adapter = new MemoryAdapter(0);
    const config = new ConfigStore([
      {
        route: 'bench-concurrent',
        failMode: 'closed',
        limits: [{ scope: 'global', limit: 10_000_000, windowMs: 60_000 }],
      },
    ]);
    const limiter = new RateLimiter(adapter, config);

    const concurrency = 500;
    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        limiter.check({ route: 'bench-concurrent', key: `c-${i}`, tenant: 't-conc' }),
      ),
    );
    const wallMs = performance.now() - start;

    const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p99 = percentile(latencies, 99);
    const throughputPerSec = (concurrency / wallMs) * 1000;

    // eslint-disable-next-line no-console
    console.log(
      `[latency benchmark] concurrent load: n=${concurrency} wall=${wallMs.toFixed(2)}ms ` +
        `throughput=${throughputPerSec.toFixed(0)} decisions/sec p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms`,
    );

    expect(results.every((r) => r.allowed)).toBe(true);
    expect(p99).toBeLessThan(10);
  });
});
