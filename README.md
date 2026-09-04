# next-clarity-brand-agent

Connect a **Next.js** site to the **Microsoft Clarity Brand Agent** — the Clarity
AI chat agent that Microsoft currently ships only as a WordPress/WooCommerce
plugin and a Shopify app.

This package speaks the same protocol as the official [`microsoft-clarity`
WordPress plugin](https://wordpress.org/plugins/microsoft-clarity/), in its
**plain-WordPress** variant: the onboarding flow that works on a content site
with no WooCommerce. Your Next.js app registers itself the way that plugin does,
proxies the widget's calls with the same HMAC contract, and serves its content
to the indexer.

> ### Read this before you install
>
> The protocol is **undocumented** and the Brand Agent is in **closed beta**.
> Microsoft can change the contract at any time, and when it does, calls fail as
> bare `401`s with no useful error. Nothing here defeats a security control —
> ownership is still proven by a nonce loopback on a domain you control — but it
> is an unofficial client for a moving target. Run it on your own domain; think
> twice before putting it on a client's production site.

---

## How the WordPress flow actually works

Worth understanding before you debug anything.

1. **Connect (server to server).** The site POSTs to
   `https://clarity.microsoft.com/wordpress/connect` with
   `{ storeUrl, clarityProjectId, wordpressSiteId, connectNonce }`.
2. **Ownership loopback.** Before answering, the Clarity dashboard calls the
   site back at `POST {storeUrl}/?rest_route=/adsagent/v1/wordpress/connect-verify`
   with that same nonce. The site must answer `{"verified":true}` with `200`.
   *This is the entire proof of ownership.*
3. **Secret minting.** Only then does Microsoft mint a per-site HMAC secret,
   register the advertiser with `Platform=WordPress`, and return the secret in
   the response to step 1.
4. **Signed traffic, both ways.**
   - *Outbound* (site → backend), `X-WordPress-*` headers: HMAC-SHA256, base64,
     over the canonical request
     `METHOD \n path+query \n timestamp \n nonce \n sha256(body) \n normalizedSite \n clientId`.
     The `clientId` is the site URL normalized: lowercased, scheme stripped, no
     trailing slash, `.` `/` `:` replaced with `-`.
   - *Inbound* (backend → site), `X-BA-*` headers: HMAC over
     `siteUrl + timestamp + sha256(body)`, valid for five minutes.
5. **Publish.** When you publish the agent from the Clarity dashboard, the
   backend calls `api/config/update` on your site and flips
   `BAInjectFrontendScript` to `true`. Only then does the widget load.

`wordpressSiteId` is **not** issued by Microsoft — the plugin generates it
locally with `wp_generate_uuid4()`. It is not a gate.

**The one thing that may still block you:** whether your `clarityProjectId` has
to belong to a project the dashboard already considers "installed via the
WordPress plugin". If Microsoft gates on that, no amount of correct headers
gets you through, and `connect` comes back non-200. That is the single unknown
this package cannot answer for you — it resolves by trying.

## Install

```bash
npm install next-clarity-brand-agent
# or straight from GitHub
npm install github:enricoangelon/next-clarity-brand-agent
```

The package ships TypeScript sources, so Next has to compile them:

```ts
// next.config.ts
const nextConfig = {
  transpilePackages: ['next-clarity-brand-agent'],
};
export default nextConfig;
```

Requires Node 20+, Next 15+ (Next 16's `proxy.ts` and Next 15's `middleware.ts`
are both supported), React 18+.

## Setup

A complete, copy-pasteable app lives in [`examples/app-router`](./examples/app-router).

### 1. Configure the agent

```ts
// brand-agent.ts
import { createBrandAgent, fileStorage, sitemapContentProvider } from 'next-clarity-brand-agent';

const siteUrl = 'https://example.com';

export const brandAgent = createBrandAgent({
  siteUrl,                                  // must be the real public domain
  clarityProjectId: process.env.CLARITY_PROJECT_ID,
  storage: fileStorage({ path: '/data/brand-agent.json' }),   // persistent volume
  encryptionKey: process.env.BRAND_AGENT_SECRET_KEY,          // openssl rand -base64 32
  content: sitemapContentProvider({ siteUrl }),
});
```

### 2. Mount the widget proxy — at `/a/msba`, not anywhere else

```ts
// app/a/msba/[...path]/route.ts
import { brandAgent } from '@/brand-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = brandAgent.handlers.proxy.GET;
export const POST = brandAgent.handlers.proxy.POST;
```

The path is **not** configurable. The widget bundle builds
`https://${location.hostname}/a/msba/api/...` itself; the WordPress plugin
answers there through an `^a/msba/(.*)` rewrite, and so must you.

| Route | Direction | What it does |
| --- | --- | --- |
| `GET /a/msba/api/config/read` | widget → backend | Widget configuration, signed and proxied |
| `GET /a/msba/api/v1/init` | widget → backend | Chat SSE stream, piped through unbuffered |
| `GET\|POST /a/msba/api/config/update` | backend → site | Flips `BAInjectFrontendScript` at publish |
| `GET /a/msba/api/config/status` | public | Connection state; the widget component reads it |
| `POST /a/msba/api/content/fetch` | backend → site | Bulk content read for the index |

### 3. Mount the ownership callback

The dashboard calls a *query-string* route (`/?rest_route=…`), which Next cannot
match on its own, so it gets rewritten first:

```ts
// proxy.ts   (middleware.ts on Next 15)
import { NextResponse } from 'next/server';
import { brandAgentProxyMatchers, brandAgentRewrite } from 'next-clarity-brand-agent/proxy';

export const config = { matcher: [...brandAgentProxyMatchers] };

export function proxy(request: NextRequest) {
  return brandAgentRewrite(request) ?? NextResponse.next();
}
```

```ts
// app/api/adsagent/v1/[...path]/route.ts
export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path.join('/') === 'wordpress/connect-verify') return brandAgent.handlers.connectVerify(request);
  return Response.json({ code: 'rest_no_route' }, { status: 404 });
}
```

### 4. Render the widget

```tsx
import { BrandAgentWidget } from 'next-clarity-brand-agent/client';

<BrandAgentWidget />
```

It loads nothing until the backend has published the agent. The check runs
client-side, after paint, against `api/config/status` — deliberately, so a flag
that changes once a month does not opt every page out of static rendering.

### 5. Connect

Expose the admin API behind your own auth and POST `{"action":"connect"}`:

```ts
const handlers = brandAgent.createAdminHandlers({ authorize: () => isAdmin() });
export const GET = handlers.GET;
export const POST = handlers.POST;
```

| Action | Effect |
| --- | --- |
| `connect` | Runs the handshake and stores the minted secret |
| `disconnect` | Notifies the backend, then wipes local state |
| `set-project-id` | Stores `projectId`, overriding the configured one |
| `set-inject` | Local override of `BAInjectFrontendScript` (testing only) |
| `sync-content` | Re-pushes every document as an `updated` webhook |

`GET` returns the status: `connected`, `unverified`, `injectFrontendScript`,
`projectId`, `siteId`, `advertiserId`, `clientId`, `connectedAt`.

**The site must be publicly reachable at `siteUrl` while you connect** — the
dashboard calls back mid-handshake. `localhost` cannot work; use a tunnel with a
stable hostname, and set `siteUrl` to that hostname.

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `siteUrl` | *(required)* | Public origin, no trailing slash. The identity you register and the origin the loopback hits. |
| `storage` | *(required)* | Where the connection lives. See below. |
| `clarityProjectId` | — | Your Clarity project id. Can also be set at runtime. |
| `encryptionKey` | — | AES-256-CBC key for the secret at rest. `null` stores it in clear. |
| `content` | — | Content provider. Without one, content endpoints return empty. |
| `allowedContentTypes` | `['post','page']` | Types the backend may request. |
| `clarityServerUrl` | `https://clarity.microsoft.com` | Override for testing. |
| `backendBaseUrl` | *(resolved)* | Pin the backend instead of discovering it. |
| `frontendInjectionUrl` | Microsoft CDN | Widget loader URL. |
| `pluginVersion` | `1.0.0` | Reported by `api/config/status`. |
| `logger` | no-op | `(message, context) => void`. |

### Storage

Three methods — `get`, `set`, `delete` — so any store works.

```ts
import { fileStorage, memoryStorage } from 'next-clarity-brand-agent';
import { sqliteStorage } from 'next-clarity-brand-agent/sqlite';

fileStorage({ path: '/data/brand-agent.json' })   // default, atomic writes
sqliteStorage({ path: '/data/brand-agent.db' })   // needs better-sqlite3
memoryStorage()                                    // tests only
```

`fileStorage` assumes a single long-lived Node process — the same assumption
WordPress makes about its options table. **On multiple instances, supply a
shared store** (Redis, KV, your database) implementing `BrandAgentStorage`;
otherwise instances disagree about the secret and the publish flag.

Losing the store means losing the HMAC secret, which means reconnecting.

### Content

The backend does not crawl: it asks the site.

```ts
// Default: read your own sitemap.xml and extract each page.
sitemapContentProvider({ siteUrl, exclude: (url) => url.includes('/legal') })

// Or feed it from your CMS / MDX / database.
staticContentProvider(async () => posts.map(toBrandAgentItem))
```

A `BrandAgentContentProvider` is one `list({ page, perPage, types })` method
returning `{ items, total }`. Items match the backend's `WordPressContentItem`
shape (`id`, `type`, `title`, `url`, `feature_image`, `content_text`, `excerpt`,
`modified`, `author`, `categories`, `tags`).

WordPress pushes updates on post save. A Next.js site usually changes at deploy
time, so call the equivalent yourself:

```ts
await brandAgent.content.syncAll();                       // after a deploy
await brandAgent.content.upsert('updated', item);         // on-demand
await brandAgent.content.deleted(id, 'page');
```

These are no-ops until the agent is published — before that there is no index on
the other side.

## Troubleshooting

**`connect` returns non-200.** Read the body: it carries Microsoft's error code.
`platform_mismatch` means that site URL is already registered as WooCommerce.
Anything else usually means the project is not eligible for this flow.

**Connect hangs, then fails.** The dashboard could not reach
`{siteUrl}/?rest_route=/adsagent/v1/wordpress/connect-verify`. Curl it yourself
with a bogus nonce — a `401 {"verified":false}` proves it is routed; a 404 means
the proxy rewrite is not in place.

**Everything 401s after connecting.** The canonical string diverged. It must be
byte-identical to the backend's, so the signed path+query has to match the URL
you actually call, and `siteUrl` has to match what you registered — exactly,
including `www` and the scheme.

**Widget never appears.** Check `api/config/status`: `BAInjectFrontendScript`
stays `false` until you publish the agent from the Clarity dashboard, and the
backend needs a working signed call to flip it.

**Content is stale or empty.** `syncAll` only runs once the agent is published;
before that, use `api/content/fetch`, which the backend calls itself.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

The suite pins the two things that cannot be debugged from the outside: the
outbound canonical request and the inbound message, each checked against a
signature computed independently with `openssl`. If a refactor reorders a field,
a test fails here instead of turning into a silent `401` in production.

## License

MIT
