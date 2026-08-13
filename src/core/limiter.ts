import { ConfigStore } from './config-store';
import { CheckRequest, CheckResult, DEFAULT_TTL_SECONDS, SlidingWindowAdapter, WindowEntry } from './types';

function buildRedisKey(req: CheckRequest, scope: WindowEntry['scope']): string {
  switch (scope) {
    case 'key':
      return `rl:{${req.route}}:key:${req.key}`;
    case 'tenant':
      return `rl:{${req.route}}:tenant:${req.tenant}`;
    case 'global':
      return `rl:{${req.route}}:global`;
  }
}

/**
 * Framework-agnostic rate-limit decision API. This is the library the NestJS sidecar
 * (and any in-process caller) wraps — it has no HTTP or Nest dependency at all.
 */
export class RateLimiter {
  constructor(private readonly adapter: SlidingWindowAdapter, private readonly config: ConfigStore) {}

  async check(req: CheckRequest): Promise<CheckResult> {
    const start = performance.now();
    const route = this.config.getRoute(req.route);
    if (!route) {
      throw new Error(`No rate-limit configuration registered for route "${req.route}"`);
    }

    const entries: WindowEntry[] = route.limits.map((rule) => ({
      scope: rule.scope,
      redisKey: buildRedisKey(req, rule.scope),
      limit: rule.limit,
      windowMs: rule.windowMs,
    }));

    try {
      const result = await this.adapter.checkAndIncrement(
        entries,
        Date.now(),
        route.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      );

      return {
        allowed: result.allowed,
        deniedScope: result.deniedIndex ? entries[result.deniedIndex - 1].scope : undefined,
        degraded: false,
        latencyMs: performance.now() - start,
      };
    } catch (err) {
      // The backend (Redis) is unreachable or errored. Apply the route's explicit
      // fail-open/fail-closed policy rather than letting the exception propagate —
      // an unhandled adapter fault should never silently become "deny everything"
      // (or "allow everything") without the route owner having chosen that outcome.
      return {
        allowed: route.failMode === 'open',
        degraded: true,
        latencyMs: performance.now() - start,
      };
    }
  }
}
