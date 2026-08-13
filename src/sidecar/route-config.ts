import { RouteConfig } from '../core/types';

/**
 * Example hierarchical route configuration for the sidecar's default routes.
 *
 * "checkout" is fail-closed: if Redis is down, deny — better to reject checkout
 * traffic than let an unbounded burst hit downstream payment infra.
 *
 * "search" is fail-open: if Redis is down, allow — a degraded, unlimited search
 * endpoint is preferable to a hard outage for a non-critical read path.
 */
export const DEFAULT_ROUTES: RouteConfig[] = [
  {
    route: 'checkout',
    failMode: 'closed',
    ttlSeconds: 120,
    limits: [
      { scope: 'key', limit: 5, windowMs: 1_000 },
      { scope: 'tenant', limit: 50, windowMs: 1_000 },
      { scope: 'global', limit: 500, windowMs: 1_000 },
    ],
  },
  {
    route: 'search',
    failMode: 'open',
    ttlSeconds: 120,
    limits: [
      { scope: 'key', limit: 20, windowMs: 1_000 },
      { scope: 'tenant', limit: 200, windowMs: 1_000 },
      { scope: 'global', limit: 5_000, windowMs: 1_000 },
    ],
  },
];
