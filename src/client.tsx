'use client';

import { useEffect } from 'react';

export interface BrandAgentWidgetProps {
  /** Status endpoint. Only change it if you mounted the proxy elsewhere. */
  statusPath?: string;
  /** Force a loader URL instead of the one the status endpoint reports. */
  src?: string;
  /** Set to false to keep the widget out (e.g. in development, or pre-consent). */
  enabled?: boolean;
}

/**
 * Loads the Brand Agent widget when — and only when — the backend has published
 * the agent for this site.
 *
 * The WordPress plugin decides this on the server while rendering the page,
 * because every request there is dynamic anyway. A Next.js site usually serves
 * static HTML, and reading the flag during render would opt every page out of
 * static rendering for a value that changes once in a blue moon. So the check
 * happens client-side, after paint, against the same unauthenticated status
 * endpoint the plugin exposes.
 */
export function BrandAgentWidget({
  statusPath = '/a/msba/api/config/status',
  src,
  enabled = true,
}: BrandAgentWidgetProps): null {
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const res = await fetch(statusPath, { cache: 'no-store' });
        if (!res.ok) return;

        const payload = (await res.json()) as {
          data?: { BAInjectFrontendScript?: string; BAOauthSuccess?: string; frontendInjectionUrl?: string };
        };
        const data = payload.data;
        if (!data) return;
        if (String(data.BAInjectFrontendScript) !== 'true') return;
        if (String(data.BAOauthSuccess) !== '1') return;

        const source = src ?? data.frontendInjectionUrl;
        if (!source || cancelled) return;
        if (document.querySelector('script[data-brand-agent]')) return;

        const script = document.createElement('script');
        script.type = 'module';
        script.src = source;
        script.dataset.brandAgent = 'true';
        document.head.appendChild(script);
      } catch {
        // The widget is an enhancement: a failed status check must never
        // surface to visitors.
      }
    }

    // Off the critical path: the agent is not part of first paint.
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const timer = idle ? idle(() => void load()) : window.setTimeout(() => void load(), 1200);

    return () => {
      cancelled = true;
      const cancelIdle = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (idle && cancelIdle) cancelIdle(timer as number);
      else window.clearTimeout(timer as number);
    };
  }, [enabled, statusPath, src]);

  return null;
}

export default BrandAgentWidget;
