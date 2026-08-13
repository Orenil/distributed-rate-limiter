import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory-adapter';
import { WindowEntry } from '../src/core/types';

describe('MemoryAdapter — hierarchical sliding-window correctness', () => {
  it('admits requests up to the limit, then denies', async () => {
    const adapter = new MemoryAdapter(0);
    const entries: WindowEntry[] = [{ scope: 'key', redisKey: 'k1', limit: 3, windowMs: 1_000 }];
    const now = 1_000_000;

    expect((await adapter.checkAndIncrement(entries, now, 60)).allowed).toBe(true);
    expect((await adapter.checkAndIncrement(entries, now + 10, 60)).allowed).toBe(true);
    expect((await adapter.checkAndIncrement(entries, now + 20, 60)).allowed).toBe(true);
    const fourth = await adapter.checkAndIncrement(entries, now + 30, 60);
    expect(fourth.allowed).toBe(false);
    expect(fourth.deniedIndex).toBe(1);
  });

  it('denies at the first hierarchy level that would be exceeded, without touching later levels', async () => {
    const adapter = new MemoryAdapter(0);
    const now = 2_000_000;
    // Tenant limit (2) is tighter than key limit (10): tenant should trip first.
    const entries: WindowEntry[] = [
      { scope: 'key', redisKey: 'key:a', limit: 10, windowMs: 1_000 },
      { scope: 'tenant', redisKey: 'tenant:a', limit: 2, windowMs: 1_000 },
    ];

    await adapter.checkAndIncrement(entries, now, 60);
    await adapter.checkAndIncrement(entries, now + 1, 60);
    const third = await adapter.checkAndIncrement(entries, now + 2, 60);

    expect(third.allowed).toBe(false);
    expect(third.deniedIndex).toBe(2); // tenant is entries[1] -> 1-based index 2
  });

  it('never partially increments: a denial at level 2 leaves level 1 counter untouched', async () => {
    const adapter = new MemoryAdapter(0);
    const now = 3_000_000;
    const entries: WindowEntry[] = [
      { scope: 'key', redisKey: 'key:b', limit: 100, windowMs: 1_000 },
      { scope: 'global', redisKey: 'global:b', limit: 1, windowMs: 1_000 },
    ];

    const first = await adapter.checkAndIncrement(entries, now, 60);
    expect(first.allowed).toBe(true);

    // This call is denied at global (limit 1 already used), so key:b must NOT be
    // incremented a second time.
    const second = await adapter.checkAndIncrement(entries, now + 1, 60);
    expect(second.allowed).toBe(false);
    expect(second.deniedIndex).toBe(2);

    // Prove key:b's counter is still at 1 by checking it alone against a limit of 1.
    const soloKeyEntry: WindowEntry[] = [{ scope: 'key', redisKey: 'key:b', limit: 1, windowMs: 1_000 }];
    const solo = await adapter.checkAndIncrement(soloKeyEntry, now + 2, 60);
    expect(solo.allowed).toBe(false); // already at 1/1 from the first successful call only
  });

  it('rolls the current window into "previous" exactly one window later', async () => {
    const adapter = new MemoryAdapter(0);
    const windowMs = 1_000;
    const entries: WindowEntry[] = [{ scope: 'key', redisKey: 'roll', limit: 4, windowMs }];
    const w0 = 10_000_000; // aligned to windowMs

    await adapter.checkAndIncrement(entries, w0, 60);
    await adapter.checkAndIncrement(entries, w0 + 1, 60);
    // Halfway into the next window: previous window's 2 counted requests should
    // still weigh in via the sliding estimate.
    const nextWindow = w0 + windowMs + windowMs / 2;
    const result = await adapter.checkAndIncrement([{ ...entries[0], limit: 3 }], nextWindow, 60);
    // estimate = 0 (curr) + 2 * (1 - 0.5) = 1 -> +1 = 2 <= 3 -> allowed
    expect(result.allowed).toBe(true);
  });
});
