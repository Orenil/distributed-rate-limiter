import { readFileSync } from 'fs';
import { join } from 'path';
import type { Redis } from 'ioredis';
import { AdapterCheckResult, SlidingWindowAdapter, WindowEntry } from '../core/types';

const SCRIPT_PATH = join(__dirname, 'lua', 'sliding-window.lua');
const SLIDING_WINDOW_LUA = readFileSync(SCRIPT_PATH, 'utf8');

/** Minimal shape this adapter needs from an ioredis client — enough to fake in tests. */
export interface RedisLike {
  defineCommand(name: string, def: { lua: string; numberOfKeys?: number }): void;
  [command: string]: any;
}

/**
 * Redis-backed sliding-window adapter. Loads adapters/lua/sliding-window.lua once via
 * ioredis's `defineCommand`, which gives us a normal-looking async method backed by
 * EVALSHA (falling back to EVAL transparently on a cache miss/NOSCRIPT) — the whole
 * hierarchical check-and-increment happens in exactly one Redis round trip.
 */
export class RedisAdapter implements SlidingWindowAdapter {
  constructor(private readonly redis: RedisLike) {
    this.redis.defineCommand('slidingWindowCheck', { lua: SLIDING_WINDOW_LUA });
  }

  async checkAndIncrement(
    entries: WindowEntry[],
    nowMs: number,
    ttlSeconds: number,
  ): Promise<AdapterCheckResult> {
    const keys = entries.map((e) => e.redisKey);
    const argv: (string | number)[] = [nowMs, ttlSeconds];
    for (const e of entries) {
      argv.push(e.limit, e.windowMs);
    }

    // ioredis-generated command signature for a script without a fixed numberOfKeys:
    // (numkeys, ...KEYS, ...ARGV)
    const [allowed, deniedIndex]: [number, number] = await this.redis.slidingWindowCheck(
      keys.length,
      ...keys,
      ...argv,
    );

    return {
      allowed: allowed === 1,
      deniedIndex: deniedIndex > 0 ? deniedIndex : null,
    };
  }
}

/** Convenience factory: build a RedisAdapter from a real ioredis connection URL. */
export function createRedisAdapter(redisUrl: string): RedisAdapter {
  // Deferred require so environments that only use the MemoryAdapter (e.g. unit tests)
  // never need a reachable Redis or even a resolvable connection string.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const IORedis = require('ioredis');
  const client: Redis = new IORedis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: false });
  return new RedisAdapter(client as unknown as RedisLike);
}
