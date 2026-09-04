// WordPress REST surface. The Clarity dashboard calls
// `POST /?rest_route=/adsagent/v1/wordpress/connect-verify`, which `proxy.ts`
// rewrites onto this route.

import { brandAgent } from '@/brand-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;

  if (path.join('/') === 'wordpress/connect-verify') {
    return brandAgent.handlers.connectVerify(request);
  }

  return Response.json({ code: 'rest_no_route' }, { status: 404 });
}
