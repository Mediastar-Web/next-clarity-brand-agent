import { PLUGIN_USER_AGENT, PROXY_BASE_PATH, normalizeSiteUrlInput, type BrandAgentContext } from './config.js';
import { buildEmbedUrl, embedOrigin, isValidProjectId } from './embed.js';
import { getHmacSecret, verifyIncomingSignature } from './crypto.js';
import { signedBackendGet } from './backend.js';
import { connect, consumeConnectNonce, disconnect, getProjectId, getSiteId, getStatus, setProjectId } from './connect.js';
import { KEYS } from './config.js';
import { syncAllContent } from './webhooks.js';

export type RouteHandler = (request: Request) => Promise<Response>;

/**
 * Raw query string of a request, `?` included (empty when there is none).
 *
 * It has to be forwarded byte-for-byte: the signature covers path + query
 * exactly as the Brand Agent server receives it, and re-serializing through
 * `URLSearchParams` changes the escaping of characters like `~` or `'`, which
 * breaks verification. (The PHP plugin does gymnastics around
 * `clientInformation` for the same reason — `$_GET` reaches it already decoded.
 * Here the problem does not exist: we forward exactly what we sign.)
 */
export function rawSearch(request: Request): string {
  const index = request.url.indexOf('?');
  return index === -1 ? '' : request.url.slice(index);
}

/** `wp_send_json_success()` envelope. */
export function wpJsonSuccess(data: unknown, status = 200): Response {
  return Response.json({ success: true, data }, { status });
}

/** `wp_send_json_error()` envelope. */
export function wpJsonError(message: string, status: number): Response {
  return Response.json({ success: false, data: { message } }, { status });
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * Throttle the two endpoints that must stay open to the public internet.
 *
 * `config/read` and `v1/init` are called by visitors' browsers, so they cannot
 * carry a credential — which makes them a signed proxy anyone can drive. The
 * limiter keeps a stranger from spending the site's Brand Agent quota.
 */
function rateLimited(ctx: BrandAgentContext, request: Request): boolean {
  return ctx.widgetRateLimiter?.limited(ctx.clientIp(request)) ?? false;
}

/**
 * The two endpoints anyone on the internet can drive, refusing to serve while
 * the limiter has no key. Shut is a worse day than throttled and a better one
 * than a stranger spending the site's quota — and unlike either of those, it
 * says which line of configuration is missing.
 */
function rateLimitUnkeyed(ctx: BrandAgentContext): Response | null {
  if (ctx.rateLimitPolicy !== 'unkeyed') return null;

  return wpJsonError(
    'Rate limiting is not configured: set `rateLimit.trustProxy` or `rateLimit.clientIp`, or `rateLimit: false` to serve this unthrottled.',
    503,
  );
}

/**
 * The origin this request reached us on, for the panel to propose as the site
 * URL. Header-derived, therefore a *suggestion*: it is shown to a signed-in
 * administrator who confirms it with a click, never adopted on its own.
 */
export function requestOrigin(request: Request): string {
  const headers = request.headers;
  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? '';
  if (!host) return '';

  const proto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || new URL(request.url).protocol.replace(':', '');
  const candidate = `${proto}://${host.split(',')[0]?.trim()}`;

  return normalizeSiteUrlInput(candidate) ?? '';
}

/**
 * Headers for a proxied widget call, built the way the plugin builds them in
 * `build_backend_request()`: its own identity and the ngrok bypass first, then
 * the visitor's `Accept` and `User-Agent` laid on top when the request carries
 * them. For real widget traffic that means the backend sees the browser, as it
 * does through WordPress; the plugin string only shows through when a caller
 * sends neither.
 */
function proxyHeaders(request: Request, base: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    ...base,
    'User-Agent': PLUGIN_USER_AGENT,
    'ngrok-skip-browser-warning': 'true',
  };

  const accept = request.headers.get('accept');
  if (accept) headers.Accept = accept;

  const userAgent = request.headers.get('user-agent');
  if (userAgent) headers['User-Agent'] = userAgent;

  return headers;
}

/**
 * What an upstream error says, for the log — and nothing else it might carry.
 *
 * A bare status cannot tell "your signature is wrong" from "this agent is not
 * published yet"; the backend writes which one it is in the body. Two things
 * keep that body from becoming a liability. It is read through a bounded
 * reader — at most 4 KB, at most two seconds, then cancelled — because a
 * non-2xx `v1/init` can still be an open event stream, and `text()` on it
 * never returns. And only named error fields of a JSON body are kept, each
 * cut short: a body that echoed the request would hand the log a signature
 * that stays valid for five minutes, and raw text is exactly what would
 * carry it.
 */
async function upstreamExcerpt(upstream: Response): Promise<Record<string, string>> {
  const contentType = upstream.headers.get('content-type') ?? '';
  const summary: Record<string, string> = { contentType: contentType.split(';')[0]?.trim() ?? '' };

  if (!upstream.body) return summary;

  const LIMIT = 4_096;
  const reader = upstream.body.getReader();
  const timer = setTimeout(() => void reader.cancel().catch(() => undefined), 1_000);
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (received < LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      // A single chunk can be any size; keep only what fits in the budget.
      const kept = value.byteLength > LIMIT - received ? value.subarray(0, LIMIT - received) : value;
      chunks.push(kept);
      received += kept.byteLength;
    }
  } catch {
    // Cancelled by the timer, or the stream failed: whatever arrived is enough.
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }

  summary.bytesRead = String(received);
  if (!contentType.toLowerCase().includes('json')) return summary;

  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const field of ['error', 'error_code', 'errorCode', 'message', 'title', 'detail', 'code']) {
        const value = (parsed as Record<string, unknown>)[field];
        if (typeof value === 'string' || typeof value === 'number') summary[field] = redactTokens(String(value));
      }
    }
  } catch {
    // Truncated or not JSON after all: the byte count and type still say something.
  }

  return summary;
}

/**
 * Anything that looks like a token — a run of base64/base64url characters long
 * enough to be a signature, a nonce or a secret — is replaced before it can be
 * logged, even inside a human-readable message. An error text that quoted our
 * own `X-WordPress-Signature` back at us would otherwise put a credential that
 * stays valid for five minutes into the log.
 */
function redactTokens(value: string): string {
  return value.replace(/[A-Za-z0-9+/_-]{24,}={0,2}/g, '[redacted]').slice(0, 160);
}

/** Path under the proxy base, e.g. `api/content/fetch`. */
function proxySubPath(request: Request): string {
  const { pathname } = new URL(request.url);
  const base = `${PROXY_BASE_PATH}/`;
  return pathname.startsWith(base) ? pathname.slice(base.length).replace(/\/+$/, '') : '';
}

// ── Widget-facing proxy (mounted under /a/msba) ────────────────────────────

/**
 * `GET /a/msba/api/config/read` — the widget's configuration, proxied to the
 * backend with the site's HMAC credentials. The widget cannot call the backend
 * directly: only the site holds the secret.
 */
async function handleConfigRead(ctx: BrandAgentContext, request: Request): Promise<Response> {
  const closed = rateLimitUnkeyed(ctx);
  if (closed) return closed;
  if (rateLimited(ctx, request)) return wpJsonError('Too many requests', 429);

  if (!(await getHmacSecret(ctx))) {
    return wpJsonError('HMAC secret not found. Please complete onboarding.', 401);
  }

  const url = new URL(request.url);
  if (!url.searchParams.get('clientId')) return wpJsonError('No clientId provided', 400);

  const pathAndQuery = `/api/config/read${rawSearch(request)}`;

  let upstream: Response;
  try {
    upstream = await signedBackendGet(
      ctx,
      pathAndQuery,
      proxyHeaders(request, { 'Content-Type': 'application/json', Accept: 'application/json' }),
      { signal: AbortSignal.timeout(30_000) },
    );
  } catch (error) {
    ctx.log('brand-agent: config/read failed', { error: error instanceof Error ? error.message : String(error) });
    return wpJsonError('Failed to get client configuration', 502);
  }

  if (!upstream.ok) {
    ctx.log('brand-agent: config/read non-success', {
      status: upstream.status,
      upstream: await upstreamExcerpt(upstream),
    });
    return wpJsonError('Failed to retrieve configuration', upstream.status);
  }

  return new Response(rewriteWidgetConfig(ctx, await upstream.text()), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * Apply `transformWidgetConfig`, preserving how the backend encodes its answer.
 *
 * That answer is double-encoded: a JSON *string* whose content is the JSON
 * object the widget parses. Re-serializing it as a plain object would hand the
 * widget something it cannot read, so the shape that came in is the shape that
 * goes out.
 *
 * Every failure path returns the original body verbatim. An override exists to
 * change an entry point, and must never be able to take the widget down with
 * it — including when Microsoft changes the payload under us.
 */
function rewriteWidgetConfig(ctx: BrandAgentContext, body: string): string {
  if (!ctx.transformWidgetConfig) return body;

  try {
    let payload: unknown = JSON.parse(body);

    const doubleEncoded = typeof payload === 'string';
    if (doubleEncoded) payload = JSON.parse(payload as string);

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      ctx.log('brand-agent: widget config not an object, left untouched');
      return body;
    }

    const draft = { ...(payload as Record<string, unknown>) };
    const next = ctx.transformWidgetConfig(draft) ?? draft;
    const encoded = JSON.stringify(next);

    return doubleEncoded ? JSON.stringify(encoded) : encoded;
  } catch (error) {
    ctx.log('brand-agent: widget config transform skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
    return body;
  }
}

/**
 * `GET /a/msba/api/v1/init` — the chat SSE stream.
 *
 * The upstream body is piped through untouched instead of buffered (the PHP
 * plugin has to buffer; we do not), so the first tokens reach the widget as
 * soon as the backend emits them.
 */
async function handleInit(ctx: BrandAgentContext, request: Request): Promise<Response> {
  const closed = rateLimitUnkeyed(ctx);
  if (closed) return closed;
  if (rateLimited(ctx, request)) return wpJsonError('Too many requests', 429);

  if (!(await getHmacSecret(ctx))) {
    return wpJsonError('HMAC secret not found. Please complete onboarding.', 401);
  }

  const url = new URL(request.url);
  if (!url.searchParams.get('clientId')) return wpJsonError('No clientId provided', 400);

  const pathAndQuery = `/api/v1/init${rawSearch(request)}`;

  let upstream: Response;
  try {
    upstream = await signedBackendGet(
      ctx,
      pathAndQuery,
      proxyHeaders(request, { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' }),
      // No timeout signal: an SSE response stays open by design. The client
      // aborting propagates through `request.signal`.
      { signal: request.signal },
    );
  } catch (error) {
    ctx.log('brand-agent: v1/init failed', { error: error instanceof Error ? error.message : String(error) });
    return wpJsonError('Failed to initialize chat', 502);
  }

  if (!upstream.ok || !upstream.body) {
    ctx.log('brand-agent: v1/init non-success', {
      status: upstream.status,
      upstream: await upstreamExcerpt(upstream),
    });
    return wpJsonError('Failed to initialize chat', upstream.status || 502);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tell reverse proxies (nginx, Coolify's Traefik with a buffering
      // middleware) not to hold the stream back.
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * `GET|POST /a/msba/api/config/update` — backend → site. This is the call that
 * flips `BAInjectFrontendScript` when the agent is published (and back to false
 * when it is disabled), so the widget appears only after a successful,
 * RAI-checked publish.
 */
async function handleConfigUpdate(ctx: BrandAgentContext, request: Request): Promise<Response> {
  const signature = request.headers.get('x-ba-signature') ?? '';
  const timestamp = request.headers.get('x-ba-timestamp') ?? '';
  const storeUrl = request.headers.get('x-ba-store-url') ?? '';

  if (!signature || !timestamp || !storeUrl) {
    return noStore(wpJsonError('Missing authentication headers', 401));
  }
  const siteUrl = await ctx.siteUrl();
  if (!siteUrl || storeUrl !== siteUrl) {
    ctx.log('brand-agent: config/update store url mismatch', { expected: siteUrl, received: storeUrl });
    return noStore(wpJsonError('Store URL mismatch', 403));
  }

  const url = new URL(request.url);
  const queryValue = url.searchParams.get('BAInjectFrontendScript');

  let value: string | null = null;
  let payload = '';

  if (queryValue !== null) {
    value = queryValue;
    // The sender hashes the query string itself, not the body.
    payload = `BAInjectFrontendScript=${queryValue}`;
  } else if (request.method === 'POST') {
    // Legacy POST form, kept for the rollout window.
    payload = await request.text();
    try {
      const data = JSON.parse(payload) as Record<string, unknown>;
      if ('BAInjectFrontendScript' in data) {
        value = data.BAInjectFrontendScript === true || data.BAInjectFrontendScript === 'true' ? 'true' : 'false';
      }
    } catch {
      // Not JSON: falls through to the missing-parameter error below.
    }
  }

  if (value === null) {
    return noStore(wpJsonError('Missing BAInjectFrontendScript parameter', 400));
  }

  // `verifyIncomingSignature` logs the reason; a second line here would only
  // double what an anonymous caller can make us write.
  if (!(await verifyIncomingSignature(ctx, signature, timestamp, payload))) {
    return noStore(wpJsonError('Invalid signature', 401));
  }

  const enabled = value === 'true';
  await ctx.storage.set(KEYS.injectScript, enabled ? 'true' : 'false');
  ctx.log('brand-agent: BAInjectFrontendScript updated', { value: enabled });

  return noStore(wpJsonSuccess({ message: 'Configuration updated', BAInjectFrontendScript: enabled ? 'true' : 'false' }));
}

/**
 * `GET /a/msba/api/config/status` — unauthenticated read-only state, same as
 * the plugin's. The bundled widget component polls it to decide whether to load
 * the agent, so it also carries the loader URL.
 */
async function handleConfigStatus(ctx: BrandAgentContext): Promise<Response> {
  const [inject, oauth, agentEnabled] = await Promise.all([
    ctx.storage.get(KEYS.injectScript),
    ctx.storage.get(KEYS.oauthSuccess),
    ctx.storage.get(KEYS.agentEnabled),
  ]);

  // The dashboard's agent switch (AGENT_ENABLED_CHANGE) rides on BAOauthSuccess
  // in the plugin. We keep it as its own flag so turning the agent off never
  // erases the record of a working connection, and fold it in only here.
  const live = oauth === '1' && agentEnabled !== '0' ? '1' : '0';

  return noStore(
    wpJsonSuccess({
      BAInjectFrontendScript: inject ?? 'false',
      BAOauthSuccess: live,
      rateLimit: ctx.rateLimitPolicy,
      pluginVersion: ctx.pluginVersion,
      frontendInjectionUrl: ctx.frontendInjectionUrl,
    }),
  );
}

/**
 * `POST /a/msba/api/content/fetch` — backend → site bulk content read, signed
 * with the same inbound contract as config/update.
 */
async function handleContentFetch(ctx: BrandAgentContext, request: Request): Promise<Response> {
  const signature = request.headers.get('x-ba-signature') ?? '';
  const timestamp = request.headers.get('x-ba-timestamp') ?? '';
  const storeUrl = request.headers.get('x-ba-store-url') ?? '';

  if (!signature || !timestamp || !storeUrl) {
    return noStore(wpJsonError('Missing authentication headers', 401));
  }
  if (storeUrl !== (await ctx.siteUrl())) {
    return noStore(wpJsonError('Store URL mismatch', 403));
  }

  const rawBody = await request.text();
  if (!(await verifyIncomingSignature(ctx, signature, timestamp, rawBody))) {
    return noStore(wpJsonError('Invalid signature', 401));
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // Empty or invalid body: fall back to the defaults below.
  }

  const requested = Array.isArray(body.types) ? body.types.map(String) : [];
  const allowed = requested.filter((type) => ctx.allowedContentTypes.includes(type));
  // An empty list means "no filter" to a content provider, so an omitted or
  // fully disallowed `types` must fall back to the allow-list itself — not to
  // `[]`, which would hand back every type the provider knows.
  const types = allowed.length > 0 ? allowed : ctx.allowedContentTypes;
  // Whole numbers, like `intval()` on the WordPress side: a fractional `page`
  // would slice a provider differently there and here, and a field that is
  // present but nonsense clamps to the bottom of the range rather than falling
  // back to the default — `intval('nope')` is 0, and `max(1, 0)` is 1.
  const whole = (value: unknown): number | null => {
    if (value === undefined || value === null) return null;
    // `intval()` on an array is 1, and on anything else non-scalar 0 — never
    // the number JavaScript would coerce out of `[20]`.
    if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') return 0;
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const page = Math.max(1, whole(body.page) ?? 1);
  const perPage = Math.min(100, Math.max(1, whole(body.per_page) ?? 50));

  if (!ctx.content) {
    ctx.log('brand-agent: content/fetch served', { page, perPage, count: 0, total: 0, provider: 'none' });
    return noStore(wpJsonSuccess({ page, per_page: perPage, total: 0, total_pages: 0, count: 0, items: [] }));
  }

  const result = await ctx.content.list({ page, perPage, types });

  // The one inbound call worth a line on success: it is the indexing step the
  // dashboard's "preparing" screen is waiting on, and silence here was
  // indistinguishable from the backend never having asked.
  ctx.log('brand-agent: content/fetch served', { page, perPage, count: result.items.length, total: result.total });

  return noStore(
    wpJsonSuccess({
      page,
      per_page: perPage,
      total: result.total,
      // `WP_Query::max_num_pages` is 0 when nothing matched, not 1.
      total_pages: result.total > 0 ? Math.ceil(result.total / perPage) : 0,
      count: result.items.length,
      items: result.items,
    }),
  );
}

/**
 * Route handlers for the widget-facing proxy. Mount them on a catch-all under
 * `/a/msba` — the path is fixed, see `PROXY_BASE_PATH`.
 */
export function createProxyHandlers(ctx: BrandAgentContext): { GET: RouteHandler; POST: RouteHandler } {
  async function dispatch(request: Request): Promise<Response> {
    const path = proxySubPath(request);

    if (path === 'api/config/read' && request.method === 'GET') return handleConfigRead(ctx, request);
    if (path === 'api/v1/init' && request.method === 'GET') return handleInit(ctx, request);
    if (path === 'api/config/update') return handleConfigUpdate(ctx, request);
    if (path === 'api/config/status' && request.method === 'GET') return handleConfigStatus(ctx);
    if (path === 'api/content/fetch' && request.method === 'POST') return handleContentFetch(ctx, request);

    return wpJsonError('Not found', 404);
  }

  return { GET: dispatch, POST: dispatch };
}

// ── Ownership callback (WordPress REST surface) ────────────────────────────

/**
 * `POST /?rest_route=/adsagent/v1/wordpress/connect-verify`
 *
 * The Clarity dashboard calls this back, with the nonce from our connect
 * request, before it mints the HMAC secret. It is public by design: at connect
 * time no shared secret exists yet, so the one-time nonce is the proof — and
 * that loopback is the whole ownership check, which is why `siteUrl` must be
 * the real public domain.
 */
export function createConnectVerifyHandler(ctx: BrandAgentContext): RouteHandler {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let nonce = url.searchParams.get('connectNonce') ?? '';

    if (!nonce) {
      const raw = await request.text();
      try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (typeof data.connectNonce === 'string') nonce = data.connectNonce;
      } catch {
        // Some callers post form-encoded bodies; try that before giving up.
        nonce = new URLSearchParams(raw).get('connectNonce') ?? '';
      }
    }

    if (await consumeConnectNonce(ctx, nonce)) {
      ctx.log('brand-agent: connect-verify matched');
      return noStore(Response.json({ verified: true }, { status: 200 }));
    }

    ctx.log('brand-agent: connect-verify rejected');
    return noStore(Response.json({ verified: false }, { status: 401 }));
  };
}

// ── Admin surface ──────────────────────────────────────────────────────────

export interface AdminHandlerOptions {
  /**
   * Decides whether the caller may manage the connection — the equivalent of
   * `current_user_can('manage_options')`. Wire it to your own admin session,
   * or to `createAdminAuth()`.
   */
  authorize: (request: Request) => boolean | Promise<boolean>;

  /**
   * CSRF tokens. The issued token is handed to the embedded dashboard as its
   * `nonce` and comes back inside every postMessage, so the panel can prove a
   * message-driven action really came from a dashboard the admin opened —
   * exactly what `wp_verify_nonce()` does in the plugin. Strongly recommended.
   */
  csrf?: {
    issue(): string | Promise<string>;
    verify(token: string | undefined | null): boolean | Promise<boolean>;
  };

  /** Deep-link the embedded dashboard to a sub-page. */
  iframeRedirect?: string;
}

/**
 * Admin API: `GET` returns the status, `POST {action}` drives the connection.
 * Actions: `connect`, `disconnect`, `set-site-url` (`siteUrl`),
 * `set-project-id` (`projectId`), `set-inject` (`enabled`, local override for
 * testing), `sync-content`.
 */
export function createAdminHandlers(
  ctx: BrandAgentContext,
  options: AdminHandlerOptions,
): { GET: RouteHandler; POST: RouteHandler } {
  async function guard(request: Request): Promise<Response | null> {
    return (await options.authorize(request)) ? null : Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return {
    async GET(request) {
      const denied = await guard(request);
      if (denied) return denied;

      const status = await getStatus(ctx);
      // Issue the nonce and build the iframe URL here, server-side: the panel
      // is a client component and must never see the signing secret.
      const csrfToken = await options.csrf?.issue();

      return noStore(
        Response.json({
          ...status,
          // What the panel offers to confirm when no domain is set yet.
          siteUrlSuggestion: status.siteUrl ? '' : requestOrigin(request),
          csrfToken,
          embedOrigin: embedOrigin(ctx.embedBaseUrl),
          embedUrl: buildEmbedUrl({
            embedBaseUrl: ctx.embedBaseUrl,
            siteUrl: status.siteUrl,
            siteId: await getSiteId(ctx),
            projectId: status.projectId,
            nonce: csrfToken ?? '',
            iframeRedirect: options.iframeRedirect,
          }),
        }),
      );
    },

    async POST(request) {
      const denied = await guard(request);
      if (denied) return denied;

      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = await request.json();
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch {
        return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
      }

      const action = typeof body.action === 'string' ? body.action : '';

      // Every mutating action needs the nonce, whether it was triggered by a
      // button in the panel or by a postMessage from the embedded dashboard.
      if (options.csrf) {
        const token =
          (typeof body.csrf === 'string' ? body.csrf : null) ?? request.headers.get('x-clarity-csrf');
        if (!(await options.csrf.verify(token))) {
          return Response.json({ error: 'Invalid or expired nonce.' }, { status: 403 });
        }
      }

      switch (action) {
        case 'connect': {
          const result = await connect(ctx);
          return noStore(
            Response.json({ ...result, status: await getStatus(ctx) }, { status: result.success ? 200 : 502 }),
          );
        }

        case 'disconnect': {
          const result = await disconnect(ctx);
          return noStore(Response.json({ ...result, status: await getStatus(ctx) }));
        }

        case 'set-site-url': {
          // The first-run equivalent of WordPress writing `home_url` during
          // its install: proposed by the panel, confirmed by a human, frozen
          // once a credential is bound to it.
          const candidate = typeof body.siteUrl === 'string' ? body.siteUrl : '';
          const result = await ctx.claimSiteUrl(candidate);
          if (!result.ok) return Response.json({ error: result.error }, { status: 400 });

          return noStore(Response.json({ success: true, status: await getStatus(ctx) }));
        }

        case 'set-project-id': {
          // Empty string is legal: it is how the dashboard unlinks a project.
          const raw = typeof body.projectId === 'string' ? body.projectId.trim() : null;
          if (raw === null || !isValidProjectId(raw)) {
            return Response.json({ error: 'projectId must be alphanumeric.' }, { status: 400 });
          }
          await setProjectId(ctx, raw);
          return noStore(Response.json({ success: true, projectId: await getProjectId(ctx) }));
        }

        case 'set-agent-enabled': {
          // The dashboard's on/off switch for the agent. Kept apart from the
          // connection record; `api/config/status` folds the two together.
          const enabled = body.enabled === true || body.enabled === 'true' || body.enabled === 1;
          await ctx.storage.set(KEYS.agentEnabled, enabled ? '1' : '0');
          ctx.log('brand-agent: agent switch', { enabled });
          return noStore(Response.json({ success: true, agentEnabled: enabled }));
        }

        case 'set-inject': {
          // Local override only: the backend owns this flag and will overwrite
          // it on the next publish. Useful to test the widget end to end.
          const enabled = body.enabled === true || body.enabled === 'true';
          await ctx.storage.set(KEYS.injectScript, enabled ? 'true' : 'false');
          return noStore(Response.json({ success: true, injectFrontendScript: enabled }));
        }

        case 'sync-content': {
          const result = await syncAllContent(ctx);
          return noStore(Response.json(result, { status: result.success ? 200 : 502 }));
        }

        default:
          return Response.json({ error: `Unknown action: ${action || '(none)'}` }, { status: 400 });
      }
    },
  };
}
