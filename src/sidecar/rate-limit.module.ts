import { Module } from '@nestjs/common';
import { ConfigStore } from '../core/config-store';
import { RateLimiter } from '../core/limiter';
import { MemoryAdapter } from '../adapters/memory-adapter';
import { createRedisAdapter } from '../adapters/redis-adapter';
import { SlidingWindowAdapter } from '../core/types';
import { RateLimitController } from './rate-limit.controller';
import { DEFAULT_ROUTES } from './route-config';
import { CONFIG_STORE, RATE_LIMITER } from './tokens';

/**
 * Wraps the framework-agnostic core library (RateLimiter + ConfigStore + a pluggable
 * SlidingWindowAdapter) as a NestJS module — this, plus the controller, is the
 * "standalone HTTP sidecar" the spec calls for. The core logic itself has zero
 * knowledge of Nest, Express, or HTTP; Nest only supplies process wiring and the
 * REST surface.
 *
 * Backend selection: set REDIS_URL to use the real Redis/Lua adapter; otherwise the
 * sidecar runs self-contained against the in-process MemoryAdapter (handy for local
 * dev, demos, and the smoke test run against this repo — see README).
 */
@Module({
  controllers: [RateLimitController],
  providers: [
    {
      provide: CONFIG_STORE,
      useFactory: () => new ConfigStore(DEFAULT_ROUTES),
    },
    {
      provide: RATE_LIMITER,
      useFactory: (config: ConfigStore) => {
        const adapter: SlidingWindowAdapter = process.env.REDIS_URL
          ? createRedisAdapter(process.env.REDIS_URL)
          : new MemoryAdapter();
        return new RateLimiter(adapter, config);
      },
      inject: [CONFIG_STORE],
    },
  ],
})
export class RateLimitModule {}
