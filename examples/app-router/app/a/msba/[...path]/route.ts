// Widget-facing proxy. The path is fixed: the Microsoft widget builds
// `https://${location.hostname}/a/msba/api/...` on its own.
//
// Serves api/config/read, api/v1/init (SSE), api/config/update,
// api/config/status and api/content/fetch.

import { brandAgent } from '@/brand-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = brandAgent.handlers.proxy.GET;
export const POST = brandAgent.handlers.proxy.POST;
