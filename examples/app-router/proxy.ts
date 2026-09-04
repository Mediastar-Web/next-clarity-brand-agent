// Next 16 renamed `middleware` to `proxy`. On 15 and earlier the same code goes
// in `middleware.ts`, exported as `middleware`.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAdminAuth } from 'next-clarity-brand-agent/auth';
import { brandAgentRewrite } from 'next-clarity-brand-agent/proxy';

// Re-created here rather than imported from `@/brand-agent`: the proxy runs on
// every matched request and must not pull in storage or the rest of the agent.
// `createAdminAuth` only touches `node:crypto`.
const adminAuth = createAdminAuth({
  password: process.env.BRAND_AGENT_ADMIN_PASSWORD,
  sessionSecret: process.env.BRAND_AGENT_SESSION_SECRET,
});

// Written out as literals on purpose: Next analyses this array statically at
// build time and ignores anything it cannot read — an imported constant or a
// spread included. The first entry catches the dashboard's ownership callback,
// which arrives as `/?rest_route=/adsagent/v1/...`; the `has` condition keeps it
// off every ordinary request to the homepage.
export const config = {
  matcher: [
    { source: '/', has: [{ type: 'query', key: 'rest_route' }] },
    '/wp-json/:path*',
    '/admin/:path*',
    '/api/admin/:path*',
  ],
};

export function proxy(request: NextRequest) {
  // The Clarity dashboard's ownership callback, rewritten off its query string.
  const rewrite = brandAgentRewrite(request);
  if (rewrite) return rewrite;

  const { pathname } = request.nextUrl;

  // Early gate for the admin surface. Defence in depth only: the route handlers
  // and the API check the session again, because a matcher change here must
  // never be the only thing standing between the internet and `connect`.
  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    // The login endpoint has to stay reachable.
    if (pathname.startsWith('/api/admin/brand-agent/session')) return NextResponse.next();

    if (!adminAuth.isAuthenticated(request)) {
      return pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        : NextResponse.next(); // let the panel render its own sign-in form
    }
  }

  return NextResponse.next();
}
