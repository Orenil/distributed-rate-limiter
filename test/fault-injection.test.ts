import { describe, expect, it } from 'vitest';
import { RedisAdapter, RedisLike } from '../src/adapters/redis-adapter';
import { ConfigStore } from '../src/core/config-store';
import { RateLimiter } from '../src/core/limiter';

/**
 * Fault injection against the real RedisAdapter code path. We substitute the
 * underlying ioredis client with a minimal fake whose script command rejects the way
 * ioredis does when Redis is unreachable (ECONNREFUSED / connection closed), so
 * RedisAdapter.checkAndIncrement really does throw through its real implementation —
 * only the network layer underneath ioredis is faked, not RedisAdapter or RateLimiter
 * themselves.
 */
function brokenRedisClient(): RedisLike {
  return {
    defineCommand(name: string) {
      // ioredis attaches the defined command as a method on the client instance.
      (this as any)[name] = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      };
    },
  };
}

describe('Redis-unavailable fault injection', () => {
  it('fails CLOSED on a route configured with failMode "closed"', async () => {
    const adapter = new RedisAdapter(brokenRedisClient());
    const config = new ConfigStore([
      {
        route: 'checkout',
        failMode: 'closed',
        limits: [{ scope: 'key', limit: 5, windowMs: 1_000 }],
      },
    ]);
    const limiter = new RateLimiter(adapter, config);

    const result = await limiter.check({ route: 'checkout', key: 'u1', tenant: 't1' });

    expect(result.allowed).toBe(false);
    expect(result.degraded).toBe(true);
  });

  it('fails OPEN on a route configured with failMode "open"', async () => {
    const adapter = new RedisAdapter(brokenRedisClient());
    const config = new ConfigStore([
      {
        route: 'search',
        failMode: 'open',
        limits: [{ scope: 'key', limit: 5, windowMs: 1_000 }],
      },
    ]);
    const limiter = new RateLimiter(adapter, config);

    const result = await limiter.check({ route: 'search', key: 'u1', tenant: 't1' });

    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });

  it('recovers to normal enforcement once the backend becomes healthy again', async () => {
    let healthy = false;
    const flakyClient: RedisLike = {
      defineCommand(name: string) {
        (this as any)[name] = async () => {
          if (!healthy) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
          return [0, 1]; // deterministic "denied at level 1" once healthy, to prove real path is used
        };
      },
    };
    const adapter = new RedisAdapter(flakyClient);
    const config = new ConfigStore([
      { route: 'checkout', failMode: 'closed', limits: [{ scope: 'key', limit: 5, windowMs: 1_000 }] },
    ]);
    const limiter = new RateLimiter(adapter, config);

    const duringOutage = await limiter.check({ route: 'checkout', key: 'u1', tenant: 't1' });
    expect(duringOutage).toMatchObject({ allowed: false, degraded: true });

    healthy = true;
    const afterRecovery = await limiter.check({ route: 'checkout', key: 'u1', tenant: 't1' });
    expect(afterRecovery).toMatchObject({ allowed: false, degraded: false }); // real script says deny, not a fault
  });
});
