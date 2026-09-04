# @mediastarweb/next-clarity-brand-agent

Connect a **Next.js** site to the **Microsoft Clarity Brand Agent** — the Clarity
AI chat agent that Microsoft currently ships only as a WordPress/WooCommerce
plugin and a Shopify app.

This package is a port of the official [`microsoft-clarity` WordPress
plugin](https://wordpress.org/plugins/microsoft-clarity/), in its
**plain-WordPress** variant: the onboarding flow that works on a content site
with no WooCommerce. Your app registers itself the way that plugin does, proxies
the widget's calls with the same HMAC contract, serves its content to the
indexer, and gives you the same control panel — the embedded Clarity dashboard —
behind an admin gate of your choosing.

> ### Read this before you install
>
> The protocol is **undocumented** and the Brand Agent is in **closed beta**.
> Microsoft can change the contract at any time, and when it does, calls fail as
> bare `401`s with no useful error. Nothing here defeats a security control —
> ownership is still proven by a nonce loopback on a domain you control — but it
> is an unofficial client for a moving target. Run it on a domain you own; think
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
5. **The dashboard drives everything else.** Linking a project, configuring the
   agent and publishing it all happen inside an iframe of
   `clarity.microsoft.com/embed`, which asks the host page — over `postMessage` —
   to store a project id, toggle the agent, or run the connect. When you publish,
   the backend calls `api/config/update` on your site and flips
   `BAInjectFrontendScript` to `true`. Only then does the widget load.

`wordpressSiteId` is **not** issued by Microsoft — the plugin generates it
locally with `wp_generate_uuid4()`. It is not a gate.

**The one thing that may still block you:** whether your `clarityProjectId` has
to belong to a project the dashboard already considers "installed via the
WordPress plugin". If Microsoft gates on that, no amount of correct headers gets
you through, and `connect` comes back non-200. That is the single unknown this
package cannot answer for you — it resolves by trying.

## What you get

- **Connect handshake** with the nonce loopback, secret read-back and all the
  failure modes the plugin guards against.
- **Widget proxy** at `/a/msba` — config, and the chat SSE stream piped through
  unbuffered.
- **Inbound endpoints** the backend calls: publish flag and bulk content read,
  both signature-verified.
- **Control panel**: the embedded Clarity dashboard plus a `postMessage` bridge,
  a status readout, and manual connect / disconnect / re-index controls.
- **Admin auth** you can use as-is (password + signed session cookie + CSRF
  nonce) or replace with your own.
- **Content indexing** from your sitemap, or from any source you wire up.
- **The Clarity analytics tag**, the other half of what the plugin installs.

## Install

```bash
npm install @mediastarweb/next-clarity-brand-agent
# or straight from GitHub
npm install github:Mediastar-Web/next-clarity-brand-agent
```

It ships compiled ESM plus type declarations, so there is nothing to configure
in `next.config.ts`. Installing straight from git runs the build through
`prepare`.

Requires Node 20+, Next 15+ (Next 16's `proxy.ts` and Next 15's `middleware.ts`
are both supported), React 18+.

## Setup

A complete, copy-pasteable app lives in [`examples/app-router`](./examples/app-router).

### 1. Configure the agent

Nothing is required to start:

```ts
// brand-agent.ts
import { createBrandAgent } from '@mediastarweb/next-clarity-brand-agent';

export const brandAgent = createBrandAgent();
```

That gets you a working panel: the state goes to `.data/brand-agent.json`, the
at-rest key is minted next to it, and the first time you open the panel it asks
you to confirm the domain — the same thing WordPress does during its install,
where `home_url` and the salts are written for you and the plugin inherits them.

One thing stays deliberately shut until you decide it: the two endpoints the
public internet can drive (`config/read`, `v1/init`) answer **503** while
nothing says how to identify a caller, because throttling them needs a key and
serving them unthrottled spends your Brand Agent quota on anyone's `for` loop.
The panel says so, and `rateLimit` below settles it in one line.

So for anything you actually deploy, pin the two facts the process cannot know
about itself — where a volume is mounted, and how many proxies are in front:

```ts
// brand-agent.ts
import { createAdminAuth, createBrandAgent, fileStorage, sitemapContentProvider } from '@mediastarweb/next-clarity-brand-agent';

const siteUrl = 'https://example.com';
const storage = fileStorage({ path: '/data/brand-agent.json' });   // persistent volume

export const brandAgent = createBrandAgent({
  siteUrl,                                  // must be the real public domain
  clarityProjectId: process.env.CLARITY_PROJECT_ID,
  storage,
  encryptionKey: process.env.BRAND_AGENT_SECRET_KEY,          // openssl rand -base64 32
  content: sitemapContentProvider({ siteUrl }),
  rateLimit: { trustProxy: 1 },             // one proxy in front; see below
});

export const adminAuth = createAdminAuth({
  password: process.env.BRAND_AGENT_ADMIN_PASSWORD,
  // Only pinned secrets can be verified from `proxy.ts`/`middleware.ts`. Set
  // both env vars, or neither — with a password pinned and no secret, sessions
  // would be signed with the one in storage and the proxy would reject them.
  sessionSecret: process.env.BRAND_AGENT_SESSION_SECRET,
  storage,                                  // also enables first-run setup
  trustProxy: 1,
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
import { brandAgentRewrite } from '@mediastarweb/next-clarity-brand-agent/proxy';

// Matchers must be written out as literals: Next reads them statically at build
// time and silently ignores anything it cannot — an imported constant or a
// spread included. `brandAgentProxyMatchers` is exported for reference only.
export const config = {
  matcher: [
    { source: '/', has: [{ type: 'query', key: 'rest_route' }] },
    '/wp-json/:path*',
    // ...your own matchers
  ],
};

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

### 4. Mount the control panel

The API — privileged, and the only surface that can connect or disconnect the
site:

```ts
// app/api/admin/brand-agent/route.ts
const handlers = brandAgent.createAdminHandlers({
  authorize: (request) => adminAuth.isAuthenticated(request),
  csrf: { issue: () => adminAuth.issueCsrf(), verify: (token) => adminAuth.verifyCsrf(token) },
});
export const GET = handlers.GET;
export const POST = handlers.POST;

// app/api/admin/brand-agent/session/route.ts
export const POST = adminAuth.handlers.POST;      // sign in
export const DELETE = adminAuth.handlers.DELETE;  // sign out
```

The page:

```tsx
// app/admin/brand-agent/page.tsx
import { BrandAgentAdmin } from '@mediastarweb/next-clarity-brand-agent/admin';

export const metadata = { robots: { index: false, follow: false } };

export default function Page() {
  return <BrandAgentAdmin apiPath="/api/admin/brand-agent" sessionPath="/api/admin/brand-agent/session" />;
}
```

That page is the plugin's wp-admin screen: status, manual controls, and the
embedded Clarity dashboard where you link the project, build the agent and
publish it. The `postMessage` bridge is wired for you — project changes, the
agent switch, and the dashboard-initiated connect — with an origin check on
every message and a server-side nonce check on every action.

**Already have an admin area?** Skip `createAdminAuth` and pass your own check
to `authorize`. Keep a CSRF token of some kind: without it, any page on the
internet could make a signed-in admin's browser POST `connect` to your site.

### 5. Render the widget and the tag

```tsx
import { BrandAgentWidget } from '@mediastarweb/next-clarity-brand-agent/client';
import { ClarityTag } from '@mediastarweb/next-clarity-brand-agent/tag';

<ClarityTag projectId={process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID} />   // in <head>
<BrandAgentWidget />                                                     // anywhere
```

`ClarityTag` renders an inline script and ships no JS bundle. `BrandAgentWidget`
loads nothing until the backend has published the agent; the check runs
client-side, after paint, against `api/config/status` — deliberately, so a flag
that changes once a month does not opt every page out of static rendering.

**Consent.** The widget loads a third-party module from Microsoft's CDN, which
then reports what the visitor is doing to Microsoft's backend. Where consent is
required, `enabled` must follow the visitor's choice rather than its default:

```tsx
const consent = useYourCookieConsent();
<BrandAgentWidget enabled={consent.thirdParty} />
```

Withdrawal is the part no script can do honestly. Flipping `enabled` back to
false removes the tag this component injected, so a later render cannot bring it
back, but code already running keeps running — **reload the page when consent is
withdrawn**. The injected tag is marked `script[data-brand-agent]`, so you can
tell whether the agent ever loaded and reload only when it did:

```tsx
useEffect(() => {
  if (!granted && document.querySelector('script[data-brand-agent]')) window.location.reload();
}, [granted]);
```

Disclosing the tool in your cookie policy is on you — it is a named third-party
recipient, like any embedded chat.

### 6. Connect

Open the panel and press **Connect** (or let the embedded dashboard do it during
its own setup flow). **The site must be publicly reachable at `siteUrl` while you
connect** — the dashboard calls back mid-handshake. `localhost` cannot work; use
a tunnel with a stable hostname and set `siteUrl` to it.

## What this claims to be

The Brand Agent backend has no Next.js integration. It has a WordPress one, and
this speaks it — which means that on the wire, deliberately, this presents
itself as the official `microsoft-clarity` plugin. Not as a shortcut: the
protocol is undocumented and closed-beta, and a request that does not look like
the one client Microsoft supports is a request that can be turned away without
explanation.

Everything that goes out says so:

| Where | Value | True? |
| --- | --- | --- |
| Iframe URL | `integration=Wordpress`, `hostingtype=selfhosted`, `WordPressBrandAgentSupported=1` | Yes — this really does implement that contract |
| Signed headers | `X-WordPress-Client-Id`, `X-WordPress-Site-Url`, `X-WordPress-Timestamp`, `X-WordPress-Nonce`, `X-WordPress-Signature` | Yes — byte-identical canonical request |
| Stored credential | `platform: wordpress` | Yes |
| Clarity tag | `?ref=wordpress` | Yes — same loader, same attribution |
| `api/config/status` | `pluginVersion: "0.10.29"` | Partly — the version of the plugin whose protocol this mirrors, not of this package |
| Widget proxy | `User-Agent: BrandAgent-WordPress-Plugin/1.0`, overwritten by the visitor's own when present | Partly — the plugin's string, sent by something that is not the plugin |
| `connect`, uninstall, content webhooks | `User-Agent: WordPress/6.8.2; https://yoursite` | **No** — nothing here runs WordPress |

That last row is the one worth knowing about. The plugin sets no `User-Agent` on
those calls, so what reaches Microsoft is WordPress core's own — and matching it
means naming a version of software that is not installed. It is a stated
fiction, `wordpressVersion` sets the number, and there is no configuration in
which this is both accurate and identical. Pick which of the two you want.

What is *not* disguised: `sitemapContentProvider` fetches your own pages as
`BrandAgent-Next/1.0`. It never talks to Microsoft, WordPress has no equivalent
to imitate (it reads its own database), and a truthful string keeps it
filterable in your access logs.

Run this on a domain you own, against a Clarity project you control. Microsoft
can change the protocol without notice, in which case calls start failing with
bare 401s.

## Security model

Some of these routes have to be open to the internet. Here is exactly which,
why, and what protects them.

| Route | Who calls it | What guards it |
| --- | --- | --- |
| `api/config/read`, `api/v1/init` | Your visitors' browsers | **Nothing can** — no credential can ride along. Rate-limited per IP (120/min by default). |
| `api/config/update`, `api/content/fetch` | Microsoft's backend | Inbound HMAC: constant-time compare, five-minute window, site-URL match, body/query bound into the signature. |
| `api/config/status` | Anyone | Nothing. It returns two booleans and the public CDN URL of the widget loader. |
| `…/connect-verify` | The Clarity dashboard | A one-time 64-hex nonce, stored only as a SHA-256 digest, valid 10 minutes, and only ever live while a connect *you started* is in flight. |
| Admin API + panel | You | Your session check **and** a CSRF nonce. Both mandatory. |
| Session endpoint (`GET`) | Anyone | Nothing. It says whether a password exists — setting one still needs the token from the server log. |

**What an attacker on the open routes can do:** spend your Brand Agent quota by
hammering `config/read` / `v1/init`, and read whether the widget is published.
**What they cannot do:** read the HMAC secret, sign anything, change the publish
flag, reach the content endpoint, or trigger a connect — every one of those is
either signature-verified or behind your admin gate.

Recommendations, in order of how much they matter:

1. **Never expose the admin API with only one of the two checks.** The session
   proves *who*; the nonce proves *which page*. The bridge accepts messages from
   an iframe hosted by Microsoft — the nonce is what stops that iframe (or any
   other page) from driving your site on its own.
2. **Set `encryptionKey`.** Without it the HMAC secret sits in clear in your
   state file. With it, a leaked file is not a usable credential.
3. **Treat the state file like a credential store.** Persistent volume,
   restricted permissions, out of your repo and out of backups you share.
4. **Give the panel its own session**, separate from any public login your app
   has. `createAdminAuth` uses an HttpOnly, SameSite=Lax, Secure cookie, a
   scrypt-hashed password, constant-time comparisons, and per-IP rate limiting
   on both login and setup attempts.
5. **Claim the panel promptly.** While no password is set, the panel advertises
   that fact (as WordPress does) and anyone holding the setup token can claim
   it. Set the password on your first visit, or pin one from the environment.
6. **Gate the panel at the edge too if you can** — an IP allow-list or a VPN in
   front of `/admin` costs nothing and removes the whole surface.
7. **Keep the proxy gate as defence in depth, never as the only check.** A
   matcher change must not be what stands between the internet and `connect`;
   the route handlers verify the session again for exactly that reason.
8. **Rotate by disconnecting.** `disconnect` tells the backend to tear the site
   down and then wipes local state; reconnecting mints a fresh secret.

Two deliberate deviations from the plugin, both hardening:

- The dashboard's `REDIRECT` operation is **ignored**. In WordPress it opens
  wp-admin's permalink settings; here it would be an outside party choosing a
  URL to open. There is no equivalent to redirect to.
- The dashboard's agent switch is stored as its own flag instead of overwriting
  `BAOauthSuccess`. Turning the agent off hides the widget without erasing the
  record of a working connection, so you never have to reconnect to turn it back
  on.

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `siteUrl` | *(confirmed from the panel)* | Public origin, no trailing slash. The identity you register and the origin the loopback hits. Left out, the panel proposes the origin you opened it on and you confirm it once; either way it is frozen while connected, because the credential is bound to it. |
| `storage` | `fileStorage()` → `.data/brand-agent.json` | Where the connection lives. See below — the default is convenient, not durable: point it at a mounted volume. |
| `clarityProjectId` | — | Your Clarity project id. Can also be linked from the panel. |
| `encryptionKey` | *(minted by the storage)* | AES-256-CBC key for the secret at rest. `fileStorage` mints one into a sibling `.key` file (mode 0600), so a leaked state dump is not a credential; an adapter without that capability stores the secret in clear and says so through `logger`. `null` asks for clear storage deliberately. |
| `content` | — | Content provider. Without one, content endpoints return empty. |
| `allowedContentTypes` | `['post','page']` | Types the backend may request. |
| `rateLimit` | `{ max: 120, windowMs: 60000 }`, **keying required** | Per-IP limit on the public widget endpoints. It has to know who is calling, so one of these is required: `trustProxy`, the number of proxies of yours that append to `X-Forwarded-For` (`1` behind a single one) — the address is read that many entries from the right, so a caller cannot pick their own key, and a chain shorter than that yields no key rather than a caller-chosen one; `clientIp: (request) => ...`, to take the address from your host; or `rateLimit: false`, to serve the endpoints unthrottled on purpose. Until one of them is given, setup and connect work normally and those two endpoints answer 503. `createAdminAuth` takes the same `trustProxy`/`clientIp` for the login throttle. |
| `clarityServerUrl` | `https://clarity.microsoft.com` | Override for testing. |
| `embedBaseUrl` | `https://clarity.microsoft.com/embed` | Panel iframe; its origin is the postMessage allow-list. |
| `backendBaseUrl` | *(resolved)* | Pin the backend instead of discovering it. |
| `transformWidgetConfig` | — | Rewrite the widget configuration on its way to the browser. See below. |
| `frontendInjectionUrl` | Microsoft CDN | Widget loader URL. |
| `pluginVersion` | `0.10.29` | Reported by `api/config/status` — the version of the plugin whose protocol this mirrors. |
| `wordpressVersion` | `6.8.2` | WordPress core version declared in the outbound `User-Agent`. A stated fiction; see *What this claims to be*. |
| `logger` | no-op | `(message, context) => void`. |

### Storage

Three methods — `get`, `set`, `delete` — so any store works.

```ts
import { fileStorage, memoryStorage } from '@mediastarweb/next-clarity-brand-agent';
import { sqliteStorage } from '@mediastarweb/next-clarity-brand-agent/sqlite';

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
await brandAgent.content.upsert('updated', item);         // on demand
await brandAgent.content.deleted(id, 'page');
```

These are no-ops until the agent is published — before that there is no index on
the other side.

### Rewriting the widget configuration

`api/config/read` is Microsoft's answer about how the agent should behave on
your pages — which entry point to draw, which nudges to run. It travels through
your origin, so you can adjust it on the way past:

```ts
createBrandAgent({
  // The dashboard decides the entry point, and does not always let you pick.
  // Forcing the chat bubble instead of the behavioural nudges:
  transformWidgetConfig: (config) => ({ ...config, IsBubbleEntrypointEnabled: true }),
});
```

Two things make this safe to use and one makes it risky.

The payload is **double-encoded** — a JSON string whose content is the JSON
object the widget parses — and the transform preserves that shape, so the widget
still reads what it expects. And every failure path serves the original answer
verbatim: a transform that throws, or a payload that stops being an object, is
skipped rather than allowed to take the widget down.

The risk is that this is an override of someone else's contract. The field names
are undocumented and unstable; when they change, your override stops applying
**silently**, because there is nothing to fail. Keep it to the few keys you
need, and re-check the widget after their updates.

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

**The panel loads but the iframe is blank.** Check the browser console for a
frame-ancestors or X-Frame-Options refusal, and confirm `embedUrl` in the admin
status response carries `integration=Wordpress` and both `*BrandAgentSupported`
flags.

**The setup form says the token is wrong.** It is regenerated only while no
password exists, and it is printed once per process — scroll back through the
server log, or restart the app to have it announced again.

**The dashboard's buttons do nothing.** Every bridge action needs a valid nonce.
If the panel has been open for hours the CSRF token has expired: reload it.

**Widget never appears.** Check `api/config/status`: `BAInjectFrontendScript`
stays `false` until you publish the agent from the Clarity dashboard, and the
backend needs a working signed call to flip it.

**Content is stale or empty.** `syncAll` only runs once the agent is published;
before that, use `api/content/fetch`, which the backend calls itself.

## Development

```bash
pnpm install
pnpm build       # compiles src/ to dist/
pnpm typecheck
pnpm test
```

To try it against a real app before publishing, install the packed tarball
rather than linking the directory — `pnpm link:`/`file:` on a *directory* leaves
a symlink outside the app's root, which Turbopack will not resolve:

```bash
npm pack                                   # in this repo
cd ../your-app && pnpm add file:../next-clarity-brand-agent/mediastarweb-next-clarity-brand-agent-0.1.0.tgz
```

`scripts/dev-seed.mjs` seeds a fake credential so you can exercise the inbound
half of the protocol — the signed `config/update` that publishes the widget —
without a public domain. Its header comment has the full recipe.

The suite pins the things that cannot be debugged from the outside: the outbound
canonical request and the inbound message, each checked against a signature
computed independently with `openssl`, plus the auth, nonce and rate-limit
behaviour. If a refactor reorders a field, a test fails here instead of turning
into a silent `401` in production.

## License

MIT
