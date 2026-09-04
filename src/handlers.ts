import { PROXY_BASE_PATH, type BrandAgentContext } from './config.js';
import { getHmacSecret, verifyIncomingSignature } from './crypto.js';
import { signedBackendGet } from './backend.js';
import { connect, consumeConnectNonce, disconnect, getProjectId, getStatus, setProjectId } from './connect.js';
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

/** Path under the proxy base, e.g. `api/config/read`. */
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
      {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'BrandAgent-Next/1.0',
      },
      { signal: AbortSignal.timeout(30_000) },
    );
  } catch (error) {
    ctx.log('brand-agent: config/read failed', { error: error instanceof Error ? error.message : String(error) });
    return wpJsonError('Failed to get client configuration', 502);
  }

  if (!upstream.ok) {
    ctx.log('brand-agent: config/read non-success', { status: upstream.status });
    return wpJsonError('Failed to retrieve configuration', upstream.status);
  }

  return new Response(await upstream.text(), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * `GET /a/msba/api/v1/init` — the chat SSE stream.
 *
 * The upstream body is piped through untouched instead of buffered (the PHP
 * plugin has to buffer; we do not), so the first tokens reach the widget as
 * soon as the backend emits them.
 */
async function handleInit(ctx: BrandAgentContext, request: Request): Promise<Response> {
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
      {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        'User-Agent': 'BrandAgent-Next/1.0',
      },
      // No timeout signal: an SSE response stays open by design. The client
      // aborting propagates through `request.signal`.
      { signal: request.signal },
    );
  } catch (error) {
    ctx.log('brand-agent: v1/init failed', { error: error instanceof Error ? error.message : String(error) });
    return wpJsonError('Failed to initialize chat', 502);
  }

  if (!upstream.ok || !upstream.body) {
    ctx.log('brand-agent: v1/init non-success', { status: upstream.status });
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
  if (storeUrl !== ctx.siteUrl) {
    ctx.log('brand-agent: config/update store url mismatch', { expected: ctx.siteUrl, received: storeUrl });
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

  if (!(await verifyIncomingSignature(ctx, signature, timestamp, payload))) {
    ctx.log('brand-agent: config/update signature rejected');
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
  const [inject, oauth] = await Promise.all([
    ctx.storage.get(KEYS.injectScript),
    ctx.storage.get(KEYS.oauthSuccess),
  ]);

  return noStore(
    wpJsonSuccess({
      BAInjectFrontendScript: inject ?? 'false',
      BAOauthSuccess: oauth ?? '0',
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
  if (storeUrl !== ctx.siteUrl) {
    return noStore(wpJsonError('Store URL mismatch', 403));
  }

  const rawBody = await request.text();
  if (!(await verifyIncomingSignature(ctx, signature, timestamp, rawBody))) {
    ctx.log('brand-agent: content/fetch signature rejected');
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
  const types = requested.filter((type) => ctx.allowedContentTypes.includes(type));
  const page = Math.max(1, Number(body.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(body.per_page) || 50));

  if (!ctx.content) {
    return noStore(wpJsonSuccess({ page, per_page: perPage, total: 0, total_pages: 0, count: 0, items: [] }));
  }

  const result = await ctx.content.list({ page, perPage, types });

  return noStore(
    wpJsonSuccess({
      page,
      per_page: perPage,
      total: result.total,
      total_pages: Math.max(1, Math.ceil(result.total / perPage)),
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
   * `current_user_can('manage_options')`. Wire it to your own admin session.
   */
  authorize: (request: Request) => boolean | Promise<boolean>;
}

/**
 * Admin API: `GET` returns the status, `POST {action}` drives the connection.
 * Actions: `connect`, `disconnect`, `set-project-id` (`projectId`),
 * `set-inject` (`enabled`, local override for testing), `sync-content`.
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
      return noStore(Response.json(await getStatus(ctx)));
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

        case 'set-project-id': {
          const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
          if (!projectId) return Response.json({ error: 'projectId is required.' }, { status: 400 });
          await setProjectId(ctx, projectId);
          return noStore(Response.json({ success: true, projectId: await getProjectId(ctx) }));
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
