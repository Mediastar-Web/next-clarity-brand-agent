// Admin API: status + connect/disconnect/sync, plus the actions the embedded
// dashboard triggers over postMessage. Everything here is privileged.

import { adminAuth, brandAgent } from '@/brand-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handlers = brandAgent.createAdminHandlers({
  authorize: (request) => adminAuth.isAuthenticated(request),

  // The nonce handed to the embedded dashboard, checked on every mutation.
  // Without it, any page that can make the browser POST here could connect or
  // disconnect the site.
  csrf: {
    issue: () => adminAuth.issueCsrf(),
    verify: (token) => adminAuth.verifyCsrf(token),
  },
});

export const GET = handlers.GET;
export const POST = handlers.POST;
