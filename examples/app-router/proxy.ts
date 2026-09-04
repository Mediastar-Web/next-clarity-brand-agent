// Next 16 renamed `middleware` to `proxy`. On 15 and earlier the same code goes
// in `middleware.ts`, exported as `middleware`.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { brandAgentProxyMatchers, brandAgentRewrite } from 'next-clarity-brand-agent/proxy';

export const config = {
  matcher: [
    ...brandAgentProxyMatchers,
    // ...your own matchers
  ],
};

export function proxy(request: NextRequest) {
  const rewrite = brandAgentRewrite(request);
  if (rewrite) return rewrite;

  return NextResponse.next();
}
