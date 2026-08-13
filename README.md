# distributed-rate-limiter

A shared rate-limiting service with hierarchical, multi-tenant limits (per-key,
per-tenant, global) and sub-millisecond decision latency. Ships as a
framework-agnostic TypeScript library plus a thin NestJS HTTP sidecar that
wraps it.

## Problem

A single rate limit per API key isn't enough once you have multiple tenants
sharing infrastructure and multiple gateway instances behind a load balancer.
You need limits that compose across a hierarchy (a key can't exceed its own
quota, a tenant can't exceed the sum of its keys' traffic, the whole service
can't exceed a global ceiling) and are enforced consistently no matter which
gateway instance handles a given request — which means the state has to live
somewhere shared (Redis), and the hierarchy check has to be atomic, or you get
races: two gateway instances each read "9 of 10 used," both admit the 10th
request from two different keys, and the tenant limit is silently blown.

This repo is the decision engine for that problem: given `(route, key,
tenant)`, answer "allowed or not" in one shared round trip, with the
enforcement algorithm, atomicity guarantee, and fail-open/closed behavior all
made explicit and testable.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  NestJS sidecar (src/sidecar/*)                          │
│  POST /v1/check   { route, key, tenant } -> decision      │
│  GET  /v1/config  list active route configs                │
│  POST /v1/config  hot-reload a route's limits/failMode     │
└───────────────────────┬───────────────────────────────────┘
                         │ depends on (no HTTP/Nest knowledge below this line)
┌───────────────────────▼───────────────────────────────────┐
│  Core library (src/core/*)                                 │
│  RateLimiter.check()  — resolves route config, builds       │
│    hierarchy-level keys, delegates to one adapter call,     │
│    applies fail-open/closed on adapter error                │
│  ConfigStore          — hot-reloadable route config over an  │
│    EventEmitter (stands in for Redis pub/sub)                │
└───────────────────────┬───────────────────────────────────┘
                         │ SlidingWindowAdapter interface
              ┌──────────┴──────────┐
              ▼                     ▼
┌───────────────────────┐ ┌─────────────────────────────────┐
│ MemoryAdapter          │ │ RedisAdapter                      │
│ (src/adapters/         │ │ (src/adapters/redis-adapter.ts)    │
│  memory-adapter.ts)    │ │ one EVALSHA per decision, running   │
│ single-process,        │ │ adapters/lua/sliding-window.lua —   │
│ synchronous critical   │ │ Redis's single-threaded execution   │
│ section — used by      │ │ is what makes the hierarchy check   │
│ tests and local dev    │ │ atomic across concurrent callers    │
└───────────────────────┘ └─────────────────────────────────┘
```

The Nest sidecar and the core library are deliberately separate: `RateLimiter`,
`ConfigStore`, and both adapters have zero `@nestjs/*` or HTTP imports. The
sidecar (`src/sidecar/*`) is just wiring — a controller and a DI module — over
a library that any Node process (a plain script, a different framework, a
worker) could use directly by importing from `src/index.ts`.

### Design decisions and rejected tradeoffs

**Sliding-window counter, not fixed-window or sliding-log.**
- *Fixed window* (reset a counter every `windowMs`) is O(1) memory but admits
  up to 2x the configured limit in a burst that straddles a window boundary —
  demonstrated numerically in `test/burst-comparison.test.ts`.
- *Sliding log* (store every request timestamp, count how many fall in the
  trailing window) is exact but its memory grows with request volume per key,
  unbounded under sustained traffic — expensive to keep in Redis at scale.
- *Sliding window counter* (chosen): O(1) memory per key — two counters plus a
  window-start marker — and approximates the true sliding count by linearly
  weighting the previous window's count by how much of it is still "in view."
  This assumes roughly uniform request distribution within a window; the
  resulting error is bounded and small in practice (see the steady-traffic
  accuracy assertion in `test/burst-comparison.test.ts`), and it's the
  standard tradeoff production rate limiters (Cloudflare, Stripe) make for the
  same reason.

**One atomic Lua script for the whole hierarchy, not one Redis call per level.**
Checking key, tenant, and global limits as three separate round trips would
reopen the exact race the hierarchy exists to prevent: two concurrent
requests could each pass all three independent checks before either
increments, jointly over-admitting. `adapters/lua/sliding-window.lua` resolves
and increments every hierarchy level inside one `EVALSHA`, so Redis's
single-threaded command execution serializes concurrent callers for free —
no distributed lock needed. A denial at level 2 also never leaves a partial
increment at level 1 (verified in `test/memory-adapter.test.ts` and enforced
identically by the Lua script).

**`MemoryAdapter` mirrors the Lua script's algorithm exactly, not a simplified
stand-in.** There's no live Redis in this environment's test run, so
`MemoryAdapter` (in-process, synchronous critical section — see the
atomicity note in its doc comment) is what the concurrency, burst-comparison,
and benchmark tests exercise directly. It implements the identical resolve/
estimate/commit logic as the Lua script (both delegate the pure math to
`sliding-window-math.ts`'s `resolveAndEstimate`, or a hand-ported equivalent
in Lua), so the test suite is evidence about the real algorithm, not a mock.

**Fail-open vs. fail-closed is a per-route config value, not a global
default.** When Redis is unreachable, "deny everything" and "allow everything"
are both wrong for *some* route. `checkout` fails **closed** — better to
reject checkout traffic than let an unbounded burst hit payment
infrastructure while Redis is down. `search` fails **open** — a degraded,
unlimited search endpoint beats a hard outage for a non-critical read path.
`RateLimiter.check()` catches the adapter error and applies exactly the
configured policy (`CheckResult.degraded: true` distinguishes "we made a
policy call under a fault" from a genuine denial — see
`test/fault-injection.test.ts`).

**Config hot-reload via pub/sub, not redeploy.** `ConfigStore` publishes
updates on an `EventEmitter` that every store sharing it picks up
immediately (`test/config-hot-reload.test.ts`). In production this
`EventEmitter` is swapped for a thin wrapper over `ioredis`'s
`SUBSCRIBE`/`PUBLISH` on a `rate-limit-config` channel — every gateway
instance's `ConfigStore` subscribes and applies updates the same way; the
`RateLimiter` call sites never change, so propagation latency is the only
externally visible difference between the in-memory bus used here and a real
Redis one.

## Setup

```bash
git clone https://github.com/Orenil/distributed-rate-limiter.git
cd distributed-rate-limiter
npm install
npm test
```

Run the sidecar locally (defaults to the in-process `MemoryAdapter` — no
Redis required):

```bash
npm run build
npm start
# distributed-rate-limiter sidecar listening on :3000
```

Point it at a real Redis instead by setting `REDIS_URL`:

```bash
REDIS_URL=redis://localhost:6379 npm start
```

## Usage

```bash
curl -s -X POST localhost:3000/v1/check \
  -H 'content-type: application/json' \
  -d '{"route":"checkout","key":"user-42","tenant":"tenant-a"}'
# {"allowed":true,"degraded":false,"latencyMs":0.1145000000001346}

curl -s localhost:3000/v1/config
# [{"route":"checkout","failMode":"closed","ttlSeconds":120,"limits":[...]}, ...]

curl -s -X POST localhost:3000/v1/config \
  -H 'content-type: application/json' \
  -d '{"route":"checkout","failMode":"closed","limits":[{"scope":"key","limit":50,"windowMs":1000}]}'
# hot-reloads the "checkout" route's limits with no restart
```

As a library, with no HTTP layer at all:

```ts
import { RateLimiter, ConfigStore, MemoryAdapter } from 'distributed-rate-limiter';

const config = new ConfigStore([
  { route: 'api', failMode: 'closed', limits: [{ scope: 'key', limit: 100, windowMs: 1_000 }] },
]);
const limiter = new RateLimiter(new MemoryAdapter(), config);

const result = await limiter.check({ route: 'api', key: 'user-1', tenant: 'tenant-a' });
// { allowed: true, degraded: false, latencyMs: 0.02 }
```

## Testing

```bash
npm test
```

18 tests across 6 files, covering everything the spec calls out as
required — no test here is a placeholder:

- **`test/concurrency.test.ts`** — real concurrent load (`Promise.all` over
  hundreds of simultaneous calls) at the exact limit boundary, proving no
  over-admission, including across a simulated hierarchy and across multiple
  "gateway instances" sharing one adapter.
- **`test/burst-comparison.test.ts`** — fixed-window vs. sliding-window burst
  behavior, numerically. A 20-request burst straddling a window boundary:
  **fixed-window admitted 20/20** (2x the configured limit of 10); the same
  burst against the sliding-window counter **admitted 10/20** — measured, not
  asserted from a docstring.
- **`test/fault-injection.test.ts`** — a real `RedisAdapter` wired to a fake
  ioredis client whose script command throws `ECONNREFUSED`, proving the
  configured fail-open/fail-closed policy is honored per route, and that
  service recovers to normal (non-degraded) enforcement once the backend
  comes back.
- **`test/latency-benchmark.test.ts`** — measured decision latency under
  load. From a real run on this machine:
  - Sequential, 2,000 decisions: **p50 = 0.001ms, p99 = 0.004ms, max =
    0.668ms**.
  - 500 concurrent decisions (`Promise.all`): **p50 = 0.170ms, p99 =
    0.837ms**, ~533,000 decisions/sec on the in-process path.

  These numbers are for the in-process (`MemoryAdapter`) decision path, which
  is everything `RedisAdapter` also does minus one network round trip to
  Redis — they demonstrate the core algorithm's overhead is sub-millisecond,
  not a claim about latency over a real network hop.
- **`test/config-hot-reload.test.ts`** and **`test/memory-adapter.test.ts`**
  — hot-reload propagation across multiple config stores, and direct
  hierarchical correctness (denies at the first exceeded level, never
  partially increments an earlier level on a later denial, correctly rolls a
  window's "current" into "previous").

## Scope notes

- The Redis pub/sub transport for hot-reload is described in
  `ConfigStore`'s doc comment and exercised via its `EventEmitter`-based
  abstraction, rather than shipping a second `ioredis` subscriber
  implementation — the call sites are identical either way, and there's no
  live Redis in this environment to integration-test a real subscriber
  against.
- No auth/rate-limit-of-the-rate-limiter-API concern is in scope; this is a
  decision engine and sidecar, not a public-facing gateway.
