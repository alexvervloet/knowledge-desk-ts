/**
 * A per-key token-bucket rate limiter, in-memory and hand-rolled.
 *
 * In-memory on purpose: it sits in front of the streaming ask endpoint as a cheap
 * per-user throttle, while the durable backstop against runaway spend is the
 * Postgres budget (see the cost ledger). Capacity and refill read from settings on
 * every call, so tests can retune them without rebuilding the limiter; the clock is
 * injectable so refill can be tested without real time passing.
 */

import { settings } from './config.ts'

/** Seconds, monotonic. `performance.now()` is milliseconds and never goes backwards. */
const monotonic = (): number => performance.now() / 1000

export class TokenBucketLimiter {
  // A bucket refills to full after burst/rate minutes of silence, at which point
  // it is indistinguishable from a key that has never been seen. Holding it after
  // that is pure leak: one entry per user id, or per client address, kept for the
  // life of the process. Public so the eviction test can name the same number
  // rather than restate it.
  static readonly EVICT_AFTER_SECONDS = 3600.0

  private readonly clock: () => number
  private buckets = new Map<string, [tokens: number, lastTs: number]>()

  /** How many buckets are held. Exposed for the eviction test. */
  get size(): number {
    return this.buckets.size
  }

  constructor(clock: () => number = monotonic) {
    this.clock = clock
  }

  reset(): void {
    this.buckets.clear()
  }

  private evictIdle(now: number): void {
    const cutoff = now - TokenBucketLimiter.EVICT_AFTER_SECONDS
    for (const [key, [, last]] of this.buckets) {
      if (last < cutoff) this.buckets.delete(key)
    }
  }

  /**
   * Consume one token for `key`. Returns [allowed, retryAfterSeconds].
   *
   * Capacity and refill default to the per-user ask limits. Callers that police a
   * different surface pass their own, reading them from settings at call time so
   * the values stay retunable without rebuilding the limiter.
   */
  check(key: string, burst?: number, perMin?: number): [boolean, number] {
    const capacity = burst ?? settings.rateBurst
    const refillPerSec = (perMin ?? settings.ratePerMin) / 60.0
    const now = this.clock()
    if (this.buckets.size > 1000) {
      // Amortized: sweeping on every call would make a cheap check O(n).
      this.evictIdle(now)
    }
    const [prevTokens, last] = this.buckets.get(key) ?? [capacity, now]
    const tokens = Math.min(capacity, prevTokens + (now - last) * refillPerSec)

    if (tokens >= 1.0) {
      this.buckets.set(key, [tokens - 1.0, now])
      return [true, 0.0]
    }
    const retry = refillPerSec > 0 ? (1.0 - tokens) / refillPerSec : 60.0
    this.buckets.set(key, [tokens, now])
    return [false, retry]
  }
}

export const limiter = new TokenBucketLimiter()

// A second bucket for the unauthenticated auth routes, keyed by caller IP rather
// than user id. Separate from `limiter` on purpose: these are the only endpoints
// an anonymous caller can reach, each one costs a bcrypt verification, and a
// password guess deserves a much tighter allowance than a question from someone
// who has already logged in.
export const authLimiter = new TokenBucketLimiter()
