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

      // Already over the limit: reject without recording the attempt. A flood
      // from one key must not buy the attacker an ever-growing array to filter
      // on every request — the bucket stays capped at `max + 1` entries, which
      // is all the window needs to decide.
      if (recent.length > options.max) {
        hits.set(key, recent);
        return true;
      }

      recent.push(now);
      hits.set(key, recent);
      return recent.length > options.max;
    },
  };
}

export interface ClientIpOptions {
  /**
   * How many reverse proxies of your own sit in front of the app and *append*
   * to `X-Forwarded-For` (nginx's `proxy_add_x_forwarded_for`, Traefik,
   * Cloudflare → your ingress...). The client address is read that many entries
   * from the right, so a header the caller wrote themselves is skipped over
   * instead of becoming their rate-limit key.
   *
   * **Unset by default, and unset means the headers are not read at all.**
   * Nothing in a request tells us how many hops are genuine, and a guess that
   * is one too low hands the caller their own key — so this has to be stated,
   * not inferred. Until it is (or `resolve` is given), the limiter has no key
   * to work with and lets everything through.
   *
   *   - `1` — the usual single proxy (Vercel, nginx, Traefik, a load balancer).
   *   - `0` / `false` — direct deployment, no proxy headers worth reading.
   *   - `true` — trust the leftmost entry. Only correct behind a proxy that
   *     *overwrites* the header rather than appending to it.
   */
  trustProxy?: boolean | number;
  /**
   * Resolve the address yourself, from whatever your host provides
   * (`request.ip`, `cf-connecting-ip`, `x-vercel-forwarded-for`...). Wins over
   * `trustProxy`.
   */
  resolve?: (request: Request) => string | null | undefined;
}

/** True when `options` names a source for the client address. */
export function hasClientIpSource(options: ClientIpOptions): boolean {
  return (
    Boolean(options.resolve) ||
    (options.trustProxy !== undefined && options.trustProxy !== false && options.trustProxy !== 0)
  );
}

/**
 * Reject a `trustProxy` that cannot be honoured, at configuration time.
 *
 * `-1`, `1.5` and `NaN` are all valid `number`s to TypeScript and all name a
 * hop that does not exist, so counting from them yields no key — which fails
 * open, silently, exactly like the unconfigured state this option exists to
 * rule out. Better to refuse the value than to look configured and throttle
 * nothing.
 */
export function assertClientIpOptions(options: ClientIpOptions, label: string): void {
  const trust = options.trustProxy;
  const valid = trust === undefined || typeof trust === 'boolean' || (Number.isInteger(trust) && trust >= 0);

  if (!valid) {
    throw new Error(
      `${label}: expected true, false, or a whole number of proxy hops (0 or more) — got ${
        typeof trust === 'string' ? JSON.stringify(trust) : String(trust)
      }.`,
    );
  }
}

/**
 * Client IP used as a rate-limit key.
 *
 * `X-Forwarded-For` is caller-supplied data: whoever is speaking to your proxy
 * can put anything at the head of it and rotate it per request. So it is read
 * only once you have said how many hops are yours, and then counted from the
 * right — past those hops — rather than taken from the front. A chain shorter
 * than the one you configured is not the chain you configured: it yields no key
 * rather than a value the caller could have written.
 */
export function clientIp(request: Request, options: ClientIpOptions = {}): string {
  if (options.resolve) return options.resolve(request)?.trim() ?? '';

  // Anything but `true` or a real hop count leaves us with no address we can
  // stand behind. (Configuration is validated up front by
  // `assertClientIpOptions`; this is the same rule, applied where it is used.)
  const trust = options.trustProxy;
  if (trust !== true && !(typeof trust === 'number' && Number.isInteger(trust) && trust > 0)) return '';

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);

    if (trust === true) return hops[0] ?? '';
    // Fewer entries than the proxies that were supposed to append them: the
    // header did not come through the path you described, so no part of it is
    // any more trustworthy than the request body.
    if (hops.length < trust) return '';
    return hops[hops.length - trust] ?? '';
  }

  // Not appendable by convention: a proxy sets it, it is not a chain.
  return request.headers.get('x-real-ip')?.trim() ?? '';
}
