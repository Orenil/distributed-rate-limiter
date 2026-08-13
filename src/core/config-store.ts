import { EventEmitter } from 'events';
import { RouteConfig } from './types';

/**
 * Hot-reloadable route configuration.
 *
 * `bus` is a plain Node EventEmitter standing in for a Redis pub/sub channel: in
 * production, swap it for a thin wrapper around `ioredis`'s SUBSCRIBE/PUBLISH (publish
 * JSON-encoded RouteConfig updates on a `rate-limit-config` channel; each gateway
 * instance's ConfigStore subscribes and applies them the same way it does here). The
 * call sites in RateLimiter never change — they only ever read from the local
 * `routes` map, so propagation latency is the only externally visible difference
 * between the in-memory bus and a real Redis one.
 */
export class ConfigStore {
  private readonly routes = new Map<string, RouteConfig>();

  constructor(initial: RouteConfig[] = [], private readonly bus: EventEmitter = new EventEmitter()) {
    for (const route of initial) this.routes.set(route.route, route);
    this.bus.on('config-updated', (config: RouteConfig) => {
      this.routes.set(config.route, config);
    });
    this.bus.on('config-removed', (route: string) => {
      this.routes.delete(route);
    });
    // Multiple ConfigStore instances (multiple gateway processes) can share one `bus`
    // to simulate hot-reload propagation across instances; see
    // test/config-hot-reload.test.ts.
    this.bus.setMaxListeners(0);
  }

  getRoute(route: string): RouteConfig | undefined {
    return this.routes.get(route);
  }

  listRoutes(): RouteConfig[] {
    return [...this.routes.values()];
  }

  /** Publish an update — applied locally and to every other store sharing this bus. */
  updateRoute(config: RouteConfig): void {
    this.bus.emit('config-updated', config);
  }

  removeRoute(route: string): void {
    this.bus.emit('config-removed', route);
  }

  /** Subscribe to config changes (e.g. for logging/metrics). Returns an unsubscribe fn. */
  onChange(listener: (config: RouteConfig) => void): () => void {
    this.bus.on('config-updated', listener);
    return () => this.bus.off('config-updated', listener);
  }
}
