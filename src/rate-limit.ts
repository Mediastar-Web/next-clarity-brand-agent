/**
 * Fixed-window rate limiter, in memory.
 *
 * The widget proxy endpoints have to be publicly reachable — they are called by
 * visitors' browsers, and no credential can be attached to them — which makes
 * them a signed proxy anyone can invoke. This keeps a stranger from spending
 * your Brand Agent quota with a `for` loop.
 *
 * Per-process state, like the WordPress plugin's own limiters: on several
 * instances each holds its own counters, so the effective limit multiplies.
 * Put a real limiter at the edge if that matters.
 */

export interface RateLimiter {
  /** Returns true when the request is over the limit and should be rejected. */
  limited(key: string): boolean;
}

export interface RateLimitOptions {
  /** Requests allowed per window, per key. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();

  return {
    limited(key: string): boolean {
      // No key (no usable client IP) means no reliable bucket: fail open rather
      // than throttle every visitor behind an unknown proxy into one counter.
      if (!key) return false;

      const now = Date.now();

      // Amortized cleanup so the map cannot grow without bound.
      if (now - lastSweep > options.windowMs) {
        for (const [entry, times] of hits) {
          if (times.every((time) => time <= now - options.windowMs)) hits.delete(entry);
        }
        lastSweep = now;
      }

      const recent = (hits.get(key) ?? []).filter((time) => time > now - options.windowMs);
      recent.push(now);
      hits.set(key, recent);
      return recent.length > options.max;
    },
  };
}

/** Best-effort client IP from the usual proxy headers. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? '';
  return request.headers.get('x-real-ip')?.trim() ?? '';
}
