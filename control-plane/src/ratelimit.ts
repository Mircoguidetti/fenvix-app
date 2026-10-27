import { ApiError } from "./errors.ts";

/**
 * Fixed-window counter per key, in memory. With several instances behind a load balancer each
 * keeps its own count, so the effective limit is the configured one times the number of
 * instances; put a shared store behind `hit` if that matters.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(windowMs = 60_000, now: () => number = Date.now) {
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Counts one request. Throws 429 with Retry-After when `limit` is exceeded in the window. */
  hit(key: string, limit: number, windowMs = this.windowMs): void {
    const t = this.now();
    if (this.windows.size > 50_000) this.sweep(t);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    if (w.count > limit) {
      const retry = Math.max(1, Math.ceil((w.resetAt - t) / 1000));
      throw new ApiError("rate_limited", `Too many requests. Try again in ${retry} seconds.`, undefined, { "Retry-After": String(retry) });
    }
  }

  /** Throws if the key is already over `limit`, without counting. */
  check(key: string, limit: number): void {
    const w = this.windows.get(key);
    if (w && w.resetAt > this.now() && w.count >= limit) {
      const retry = Math.max(1, Math.ceil((w.resetAt - this.now()) / 1000));
      throw new ApiError("rate_limited", `Too many requests. Try again in ${retry} seconds.`, undefined, { "Retry-After": String(retry) });
    }
  }

  private sweep(t: number): void {
    for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k);
  }
}
