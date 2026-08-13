import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/adapters/memory-adapter';
import { ConfigStore } from '../src/core/config-store';
import { RateLimiter } from '../src/core/limiter';

/**
 * Hot-reload is a "definition of done" requirement: limit config must be updatable
 * without restarting a gateway process. Here that's modeled as multiple ConfigStore
 * instances (standing in for multiple gateway processes) sharing one EventEmitter
 * (standing in for a Redis pub/sub channel — see the doc comment on ConfigStore).
 * A publish on any store must be visible to every other store sharing the bus.
 */
describe('hot-reloadable config', () => {
  it('propagates a limit change to every ConfigStore sharing the bus, with no restart', async () => {
    const bus = new EventEmitter();
    const initial = [{ route: 'api', failMode: 'closed' as const, limits: [{ scope: 'key' as const, limit: 2, windowMs: 1_000 }] }];

    // Two independent "gateway instances", each with its own store + limiter, sharing
    // one adapter (as they would share one Redis) and one config bus.
    const adapter = new MemoryAdapter(0);
    const storeA = new ConfigStore(initial, bus);
    const storeB = new ConfigStore(initial, bus);
    const gatewayA = new RateLimiter(adapter, storeA);
    const gatewayB = new RateLimiter(adapter, storeB);

    // Exhaust the original limit (2) via gateway A.
    await gatewayA.check({ route: 'api', key: 'u1', tenant: 't1' });
    await gatewayA.check({ route: 'api', key: 'u1', tenant: 't1' });
    const deniedUnderOldLimit = await gatewayB.check({ route: 'api', key: 'u1', tenant: 't1' });
    expect(deniedUnderOldLimit.allowed).toBe(false);

    // Publish a raised limit from gateway A's store; gateway B never touches storeA
    // directly, only the shared bus — this proves propagation, not a shared reference.
    storeA.updateRoute({
      route: 'api',
      failMode: 'closed',
      limits: [{ scope: 'key', limit: 100, windowMs: 1_000 }],
    });

    expect(storeB.getRoute('api')?.limits[0].limit).toBe(100);

    // gateway B (a different process, in the model) now enforces the raised limit
    // immediately, with no restart and no redeploy.
    const afterReload = await gatewayB.check({ route: 'api', key: 'u1', tenant: 't1' });
    expect(afterReload.allowed).toBe(true);
  });

  it('removeRoute propagates removal to every store sharing the bus', () => {
    const bus = new EventEmitter();
    const storeA = new ConfigStore(
      [{ route: 'temp', failMode: 'open', limits: [{ scope: 'key', limit: 1, windowMs: 1_000 }] }],
      bus,
    );
    const storeB = new ConfigStore([], bus);
    storeB.updateRoute({ route: 'temp', failMode: 'open', limits: [{ scope: 'key', limit: 1, windowMs: 1_000 }] });
    expect(storeA.getRoute('temp')).toBeDefined();

    storeB.removeRoute('temp');
    expect(storeA.getRoute('temp')).toBeUndefined();
  });

  it('onChange notifies subscribers of every published update', () => {
    const store = new ConfigStore();
    const seen: string[] = [];
    const unsubscribe = store.onChange((config) => seen.push(config.route));

    store.updateRoute({ route: 'x', failMode: 'closed', limits: [] });
    store.updateRoute({ route: 'y', failMode: 'open', limits: [] });
    unsubscribe();
    store.updateRoute({ route: 'z', failMode: 'open', limits: [] });

    expect(seen).toEqual(['x', 'y']);
  });
});
