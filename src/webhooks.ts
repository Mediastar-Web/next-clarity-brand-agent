import { CONTENT_WEBHOOK_BASE_PATH, KEYS, type BrandAgentContext } from './config.js';
import { getHmacSecret } from './crypto.js';
import { signedBackendPost } from './backend.js';
import type { BrandAgentContentItem } from './types.js';

export type ContentEvent = 'created' | 'updated' | 'deleted';

/**
 * Whether incremental content webhooks should be emitted at all:
 * the site must be connected, the agent must not be switched off, and it must
 * be published (`BAInjectFrontendScript === 'true'`, flipped by the backend at
 * go-live).
 *
 * Before publish there is no document index to apply changes to, so anything
 * sent earlier is dropped on the other side. The agent switch is checked here
 * too: `AGENT_ENABLED_CHANGE` deliberately leaves `BAOauthSuccess` alone (so a
 * working connection is never erased) and does not always clear the injection
 * flag, so it is the only signal that the administrator turned the agent off.
 */
export async function contentWebhooksEnabled(ctx: BrandAgentContext): Promise<boolean> {
  if (!(await getHmacSecret(ctx))) return false;
  if ((await ctx.storage.get(KEYS.oauthSuccess)) !== '1') return false;
  if ((await ctx.storage.get(KEYS.agentEnabled)) === '0') return false;
  return (await ctx.storage.get(KEYS.injectScript)) === 'true';
}

/**
 * Deliver one content webhook.
 *
 * The signed path and the delivered URL are built from the same string, because
 * the signature covers path + query as the backend reconstructs it.
 */
export async function dispatchContentWebhook(
  ctx: BrandAgentContext,
  event: ContentEvent,
  body: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const siteUrl = await ctx.siteUrl();
  if (!siteUrl) return { ok: false, error: 'No site URL confirmed.' };

  const pathAndQuery =
    `${CONTENT_WEBHOOK_BASE_PATH}content/${encodeURIComponent(event)}` +
    `?store_url=${encodeURIComponent(siteUrl)}`;

  try {
    const res = await signedBackendPost(ctx, pathAndQuery, body);
    if (!res.ok) ctx.log('brand-agent: content webhook rejected', { event, status: res.status });
    return { ok: res.ok, status: res.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log('brand-agent: content webhook failed', { event, error: message });
    return { ok: false, error: message };
  }
}

/** Push a created/updated document. No-op while webhooks are disabled. */
export async function notifyContentUpsert(
  ctx: BrandAgentContext,
  event: 'created' | 'updated',
  item: BrandAgentContentItem,
): Promise<boolean> {
  if (!(await contentWebhooksEnabled(ctx))) return false;
  return (await dispatchContentWebhook(ctx, event, JSON.stringify(item))).ok;
}

/** Push a deletion. The backend removes the document by its deterministic id. */
export async function notifyContentDeleted(
  ctx: BrandAgentContext,
  id: number,
  type: string,
): Promise<boolean> {
  if (!(await contentWebhooksEnabled(ctx))) return false;
  return (await dispatchContentWebhook(ctx, 'deleted', JSON.stringify({ id, type }))).ok;
}

/**
 * Re-push every document the content provider knows about, as `updated`.
 *
 * WordPress syncs on post save; a Next.js site usually changes at deploy time,
 * so this is the equivalent hook — call it from a deploy step, a cron route, or
 * the admin panel.
 */
export async function syncAllContent(
  ctx: BrandAgentContext,
  options: { perPage?: number } = {},
): Promise<{ success: boolean; sent: number; failed: number; error?: string }> {
  if (!ctx.content) return { success: false, sent: 0, failed: 0, error: 'No content provider configured.' };
  if (!(await contentWebhooksEnabled(ctx))) {
    return {
      success: false,
      sent: 0,
      failed: 0,
      error: 'Content sync is off: the site is not connected, or the agent is not published yet.',
    };
  }

  // Clamped, not trusted: `Math.ceil(total / 0)` is Infinity, and a loop bound
  // by that against a provider that never throws does not end. Same 1..100
  // range the backend's own `per_page` is held to.
  const requested = Math.floor(Number(options.perPage ?? 25));
  const perPage = Number.isFinite(requested) && requested > 0 ? Math.min(100, requested) : 25;
  let sent = 0;
  let failed = 0;
  let pages = 1;

  // Sequential on purpose: this is a background chore, and hammering the
  // backend from a marketing site buys nothing.
  //
  // Termination follows the reported total, not `items.length`: a provider can
  // legitimately return an empty page (the sitemap one does when every URL in
  // that slice times out), and stopping there would silently abandon the rest
  // of the site while still reporting success.
  for (let page = 1; page <= pages; page += 1) {
    const { items, total } = await ctx.content.list({ page, perPage, types: [] });
    if (page === 1) pages = Math.max(1, Math.ceil(total / perPage));

    // Documents the provider promised for this page but did not produce.
    const expected = Math.min(perPage, Math.max(0, total - (page - 1) * perPage));
    failed += Math.max(0, expected - items.length);

    for (const item of items) {
      const result = await dispatchContentWebhook(ctx, 'updated', JSON.stringify(item));
      if (result.ok) sent += 1;
      else failed += 1;
    }
  }

  ctx.log('brand-agent: content sync finished', { sent, failed });
  return { success: failed === 0, sent, failed };
}
