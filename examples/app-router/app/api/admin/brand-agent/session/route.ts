// Sign in / sign out of the control panel.

import { adminAuth } from '@/brand-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = adminAuth.handlers.POST;
export const DELETE = adminAuth.handlers.DELETE;
