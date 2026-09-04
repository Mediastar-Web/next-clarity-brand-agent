// Sign in / sign out of the control panel, and — on first run — choose the
// admin password.
//
//   GET    → { configured, needsSetup }   (public: it only says whether a
//                                          password exists, and the setup form
//                                          still needs the token from the log)
//   POST   → sign in
//   PUT    → first-run setup { token, password }
//   PATCH  → change password { currentPassword, newPassword }
//   DELETE → sign out

import { adminAuth } from '@/brand-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = adminAuth.handlers.GET;
export const POST = adminAuth.handlers.POST;
export const PUT = adminAuth.handlers.PUT;
export const PATCH = adminAuth.handlers.PATCH;
export const DELETE = adminAuth.handlers.DELETE;
