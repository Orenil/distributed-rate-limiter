/**
 * Framework-agnostic core types shared by every adapter and by the NestJS sidecar.
 */

/** A level in the limit hierarchy. Evaluated together, atomically, per decision. */
export type LimitScope = 'key' | 'tenant' | 'global';

/** One sliding-window rule at a given hierarchy level. */
export interface LimitRule {
  scope: LimitScope;
  /** Max requests admitted within `windowMs`, using the sliding-window-counter estimate. */
  limit: number;
  windowMs: number;
}

/** What to do when the backing store (Redis) is unreachable. */
export type FailMode = 'open' | 'closed';

/** Per-route configuration: which hierarchy levels apply, and fail-open/closed behavior. */
export interface RouteConfig {
  route: string;
  limits: LimitRule[];
  failMode: FailMode;
  /** How long an idle counter entry survives before Redis/memory reclaims it. */
  ttlSeconds?: number;
}

/** A single rate-limit decision request. */
export interface CheckRequest {
  route: string;
  key: string;
  tenant: string;
}

/** The outcome of a decision. */
export interface CheckResult {
  allowed: boolean;
  /** The hierarchy level that caused a denial, if any. */
  deniedScope?: LimitScope;
  /** True when the decision was made under a backend fault via the route's fail-open policy. */
  degraded: boolean;
  latencyMs: number;
}

/** One resolved hierarchy-level entry ready to hand to an adapter. */
export interface WindowEntry {
  scope: LimitScope;
  redisKey: string;
  limit: number;
  windowMs: number;
}

/** Result of a raw adapter-level atomic check across all hierarchy entries. */
export interface AdapterCheckResult {
  allowed: boolean;
  /** 1-based index into the entries array that caused denial, or null if allowed. */
  deniedIndex: number | null;
}

/**
 * Pluggable backend for the atomic hierarchical sliding-window check.
 * Implementations: RedisAdapter (Lua script, cross-process) and MemoryAdapter
 * (single-process, synchronous critical section).
 */
export interface SlidingWindowAdapter {
  checkAndIncrement(
    entries: WindowEntry[],
    nowMs: number,
    ttlSeconds: number,
  ): Promise<AdapterCheckResult>;
}

export const DEFAULT_TTL_SECONDS = 120;
