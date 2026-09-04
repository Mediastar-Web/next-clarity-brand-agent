// Mount the widget once, in the root layout (or in whatever wrapper renders on
// every public page). It loads nothing until the backend publishes the agent.

import { BrandAgentWidget } from 'next-clarity-brand-agent/client';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <BrandAgentWidget enabled={process.env.NODE_ENV === 'production'} />
      </body>
    </html>
  );
}
