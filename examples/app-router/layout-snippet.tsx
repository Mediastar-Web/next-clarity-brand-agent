// Two things go in the root layout (or in whatever wrapper renders on every
// public page):
//
//   - the Clarity analytics tag, as soon as a project id is set — the plugin
//     prints it in `wp_head`, and a project with no traffic is not much use to
//     an agent;
//   - the Brand Agent widget, which stays dormant until the backend publishes
//     the agent.

import { BrandAgentWidget } from 'next-clarity-brand-agent/client';
import { ClarityTag } from 'next-clarity-brand-agent/tag';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <ClarityTag projectId={process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID} />
      </head>
      <body>
        {children}
        <BrandAgentWidget enabled={process.env.NODE_ENV === 'production'} />
      </body>
    </html>
  );
}
