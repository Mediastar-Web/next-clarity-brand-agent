// The control panel: status, manual controls, and the embedded Clarity
// dashboard where the agent is actually configured and published.
//
// Keep it out of search engines, and behind the same gate as the API — the
// component itself only renders what the API is willing to hand it, but there
// is no reason to advertise the page.

import { BrandAgentAdmin } from '@mediastarweb/next-clarity-brand-agent/admin';

export const metadata = { robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default function BrandAgentAdminPage() {
  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <BrandAgentAdmin
        apiPath="/api/admin/brand-agent"
        sessionPath="/api/admin/brand-agent/session"
      />
    </main>
  );
}
