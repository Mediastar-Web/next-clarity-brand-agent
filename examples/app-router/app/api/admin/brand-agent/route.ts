// Admin API: status + connect/disconnect/sync. Guard it with your own auth —
// this is the equivalent of the plugin's `current_user_can('manage_options')`.

import { brandAgent } from '@/brand-agent';
import { isAuthenticatedAdmin } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handlers = brandAgent.createAdminHandlers({
  authorize: async () => isAuthenticatedAdmin(),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
