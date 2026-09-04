'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { MessageOperation, isValidProjectId } from './embed.js';
import type { BrandAgentStatus } from './types.js';

/**
 * The control panel — the Next.js equivalent of the plugin's wp-admin page.
 *
 * Two halves, exactly like the plugin:
 *   1. the embedded Clarity dashboard, where you actually link a project,
 *      configure the agent and publish it;
 *   2. a postMessage bridge, because that dashboard cannot touch your site
 *      directly — it asks the host page to store a project id, flip the agent
 *      switch, or run the server-to-server connect.
 *
 * Everything the bridge triggers goes through your admin API, which re-checks
 * the session and the nonce server-side. A message can ask; only the server
 * decides. On top of that we add what WordPress gives the plugin for free: a
 * status readout and manual controls, so the connection can be driven even if
 * the dashboard is unreachable.
 */

/** The status, plus what only the admin API can add to it. */
type AdminStatus = BrandAgentStatus & { siteUrlSuggestion?: string };

export interface BrandAgentAdminProps {
  /** Admin API route (`createAdminHandlers`). */
  apiPath?: string;
  /** Login/logout route (`createAdminAuth().handlers`). Enables the password form. */
  sessionPath?: string;
  /** Render the embedded Clarity dashboard. */
  showEmbed?: boolean;
  /** Height of the embed, in CSS units. Defaults to `100vh` in `embed` layout. */
  embedHeight?: string;
  /**
   * `embed` (default) — the dashboard and nothing else, the way the WordPress
   * plugin's wp-admin screen looks: onboarding, project linking, agent build
   * and publish all happen inside it. Status and manual controls stay one click
   * away, under *Details*.
   *
   * `full` — everything visible at once. Useful while setting the integration
   * up, or when the dashboard itself is unreachable and you have to drive the
   * connection by hand.
   *
   * Blocking warnings (a domain still to confirm, the widget endpoints closed,
   * state on an ephemeral disk) are shown in both: they are the ones WordPress
   * never has to raise, and hiding them would only move the confusion.
   */
  layout?: 'embed' | 'full';
}

type LogEntry = { at: string; message: string; tone: 'info' | 'ok' | 'error' };

/** What the session endpoint says about the admin password. */
type AuthInfo = { configured: boolean; needsSetup: boolean; source: 'env' | 'storage' | 'none' };

const styles = {
  root: {
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    color: '#e8e8ea',
    background: '#111114',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.12)',
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  row: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  grid: { display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' },
  cell: { background: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: '10px 12px' },
  label: { fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.5 },
  value: { fontSize: 14, marginTop: 2, wordBreak: 'break-all' },
  button: {
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.18)',
    background: 'rgba(255,255,255,0.08)',
    color: 'inherit',
    padding: '8px 14px',
    fontSize: 13,
    cursor: 'pointer',
  },
  input: {
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.18)',
    background: 'rgba(0,0,0,0.35)',
    color: 'inherit',
    padding: '8px 10px',
    fontSize: 13,
    minWidth: 200,
  },
  notice: {
    border: '1px solid rgba(255,159,10,0.4)',
    background: 'rgba(255,159,10,0.1)',
    borderRadius: 10,
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  noticeTitle: { fontSize: 13, fontWeight: 600 },
  noticeBody: { fontSize: 12.5, lineHeight: 1.55, opacity: 0.85 },
  iframe: { width: '100%', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 12, background: '#fff' },
  log: { fontSize: 12, lineHeight: 1.6, maxHeight: 150, overflowY: 'auto', opacity: 0.85 },
} as const satisfies Record<string, CSSProperties>;

function Chip({ label, tone }: { label: string; tone: 'ok' | 'warn' | 'off' }) {
  const palette = {
    ok: { background: 'rgba(52,199,89,0.16)', color: '#7ee49a', border: '1px solid rgba(52,199,89,0.4)' },
    warn: { background: 'rgba(255,159,10,0.16)', color: '#ffc470', border: '1px solid rgba(255,159,10,0.4)' },
    off: { background: 'rgba(255,255,255,0.06)', color: 'rgba(232,232,234,0.6)', border: '1px solid rgba(255,255,255,0.16)' },
  }[tone];

  return (
    <span style={{ ...palette, borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>{label}</span>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.cell}>
      <div style={styles.label}>{label}</div>
      <div style={styles.value}>{value || '—'}</div>
    </div>
  );
}

export function BrandAgentAdmin({
  apiPath = '/api/admin/brand-agent',
  sessionPath,
  showEmbed = true,
  embedHeight,
  layout = 'embed',
}: BrandAgentAdminProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unauthorized' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [projectDraft, setProjectDraft] = useState('');
  const [siteUrlDraft, setSiteUrlDraft] = useState('');
  /**
   * Frozen on first load, on purpose.
   *
   * Every status read mints a fresh CSRF nonce, and the nonce is inside the
   * iframe URL — so following `status.embedUrl` meant that saving a project id,
   * connecting, or any other action changed the `src` and reloaded the whole
   * dashboard from scratch, throwing the administrator back to its start page
   * mid-onboarding. WordPress never has this problem: its page is rendered once
   * and the iframe is never touched again. The nonce we hand the dashboard stays
   * valid for its full lifetime, and the panel's own actions keep using the
   * fresh token from `statusRef`. Reload the page for a new one.
   */
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [authInfo, setAuthInfo] = useState<AuthInfo | null>(null);
  const [setupToken, setSetupToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPasswordChange, setShowPasswordChange] = useState(false);

  // The bridge reads the freshest status without re-subscribing on every change.
  const statusRef = useRef<AdminStatus | null>(null);
  statusRef.current = status;

  const append = useCallback((message: string, tone: LogEntry['tone'] = 'info') => {
    setLog((entries) => [{ at: new Date().toLocaleTimeString(), message, tone }, ...entries].slice(0, 30));
  }, []);

  const refresh = useCallback(async () => {
    // Unauthenticated and cheap: tells us whether to show a login form or a
    // first-run setup form, and whether the password can be changed at all.
    if (sessionPath) {
      try {
        const res = await fetch(sessionPath, { cache: 'no-store' });
        if (res.ok) setAuthInfo((await res.json()) as AuthInfo);
      } catch {
        // Ignored: the panel still works, it just cannot offer setup.
      }
    }

    try {
      const res = await fetch(apiPath, { cache: 'no-store' });
      if (res.status === 401 || res.status === 403) {
        setState('unauthorized');
        return;
      }
      if (!res.ok) {
        setState('error');
        return;
      }
      const next = (await res.json()) as AdminStatus;
      setStatus(next);
      setProjectDraft(next.projectId ?? '');
      // Prefilled with the origin this page was served from, so confirming the
      // domain is one click in the ordinary case.
      setSiteUrlDraft((current) => current || next.siteUrl || next.siteUrlSuggestion || '');
      setEmbedUrl((current) => current ?? next.embedUrl ?? null);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [apiPath, sessionPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (action: string, payload: Record<string, unknown> = {}, nonce?: string): Promise<boolean> => {
      setBusy(true);
      try {
        const res = await fetch(apiPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, csrf: nonce ?? statusRef.current?.csrfToken, ...payload }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

        if (res.ok && data.success !== false) {
          append(`${action}: ok`, 'ok');
          return true;
        }

        append(`${action}: ${String(data.error ?? data.errorCode ?? res.status)}`, 'error');
        return false;
      } catch (error) {
        append(`${action}: ${error instanceof Error ? error.message : 'network error'}`, 'error');
        return false;
      } finally {
        setBusy(false);
        void refresh();
      }
    },
    [apiPath, append, refresh],
  );

  // ── postMessage bridge (js/add_window_listeners.js) ──────────────────────
  useEffect(() => {
    if (state !== 'ready') return;

    const trustedOrigin = statusRef.current?.embedOrigin;
    if (!trustedOrigin) return;

    const onMessage = (event: MessageEvent) => {
      // The single most important line here: anyone can postMessage this
      // window, so a message that is not from the dashboard we framed is not a
      // message at all.
      if (event.origin !== trustedOrigin) return;

      const data = event.data as { operation?: number; id?: unknown; status?: unknown; nonce?: unknown } | null;
      if (!data || typeof data.operation !== 'number') return;

      // The dashboard echoes the nonce we handed it in the iframe URL, and the
      // server verifies it before acting. No fallback to the panel's own token:
      // the session proves who, this proves which page asked, and quietly
      // substituting one for the other would drop half the check the plugin
      // makes.
      const nonce = typeof data.nonce === 'string' ? data.nonce : '';
      if (!nonce) {
        append('dashboard: message without a nonce, ignored', 'error');
        return;
      }

      switch (data.operation) {
        case MessageOperation.PROJECT_ID_CHANGE: {
          if (!isValidProjectId(data.id)) return;
          append(data.id === '' ? 'dashboard: project unlinked' : `dashboard: project ${data.id}`);
          void act('set-project-id', { projectId: data.id }, nonce);
          return;
        }

        case MessageOperation.AGENT_ENABLED_CHANGE: {
          const enabled = data.status !== false;
          append(`dashboard: agent ${enabled ? 'enabled' : 'disabled'}`);
          void act('set-agent-enabled', { enabled }, nonce);
          return;
        }

        case MessageOperation.WORDPRESS_CONNECT: {
          append('dashboard: connect requested');
          void act('connect', {}, nonce).then((ok) => {
            // The dashboard waits for this reply to advance its setup flow.
            (event.source as Window | null)?.postMessage(
              { type: ok ? 'WORDPRESS_CONNECT_SUCCESS' : 'WORDPRESS_CONNECT_FAILURE' },
              trustedOrigin,
            );
          });
          return;
        }

        case MessageOperation.REDIRECT:
          // WordPress-only: it deep-links wp-admin's permalink settings, which
          // has no counterpart here. Deliberately ignored rather than followed.
          append('dashboard: redirect request ignored (WordPress-only)');
          return;

        default:
          return;
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [state, act, append]);

  // ── Login / prima configurazione ─────────────────────────────────────────
  if (state === 'unauthorized') {
    if (!sessionPath) {
      return (
        <div style={styles.root}>
          <strong>Not authorized.</strong>
          <span style={{ opacity: 0.7, fontSize: 13 }}>Sign in to your admin area, then reload this page.</span>
        </div>
      );
    }

    // No password anywhere yet: offer to set one. Gated by the token the server
    // printed to its own log — without it, whoever loads this page first would
    // simply claim the panel.
    if (authInfo?.needsSetup) {
      return (
        <div style={styles.root}>
          <strong>Brand Agent — first run</strong>
          <span style={{ opacity: 0.7, fontSize: 13 }}>
            Choose the admin password. Paste the setup token your server printed to its log at startup — it proves
            you own this deployment, not just its URL.
          </span>
          <form
            style={{ ...styles.row, flexDirection: 'column', alignItems: 'stretch', gap: 8, maxWidth: 420 }}
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                const res = await fetch(sessionPath, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ token: setupToken.trim(), password }),
                });
                if (res.ok) {
                  setPassword('');
                  setSetupToken('');
                  setState('loading');
                  await refresh();
                } else {
                  const data = (await res.json().catch(() => ({}))) as { error?: string };
                  append(data.error ?? 'Setup failed.', 'error');
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            <input
              style={styles.input}
              value={setupToken}
              placeholder="Setup token (from the server log)"
              onChange={(event) => setSetupToken(event.target.value)}
            />
            <input
              style={styles.input}
              type="password"
              value={password}
              autoComplete="new-password"
              placeholder="New admin password (10+ characters)"
              onChange={(event) => setPassword(event.target.value)}
            />
            <button style={styles.button} type="submit" disabled={busy}>
              Set password and sign in
            </button>
          </form>
          {log.length > 0 && <div style={styles.log}>{log[0]?.message}</div>}
        </div>
      );
    }

    return (
      <div style={styles.root}>
        <strong>Brand Agent — sign in</strong>
        <form
          style={styles.row}
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              const res = await fetch(sessionPath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
              });
              if (res.ok) {
                setPassword('');
                setState('loading');
                await refresh();
              } else {
                const data = (await res.json().catch(() => ({}))) as { error?: string };
                append(data.error ?? 'Login failed.', 'error');
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          <input
            style={styles.input}
            type="password"
            value={password}
            autoComplete="current-password"
            placeholder="Admin password"
            onChange={(event) => setPassword(event.target.value)}
          />
          <button style={styles.button} type="submit" disabled={busy}>
            Sign in
          </button>
        </form>
        {log.length > 0 && <div style={styles.log}>{log[0]?.message}</div>}
      </div>
    );
  }

  if (state === 'loading') return <div style={styles.root}>Loading…</div>;
  if (state === 'error' || !status) return <div style={styles.root}>Could not reach the admin API.</div>;

  const connectionChip = status.connected
    ? status.unverified
      ? { label: 'Connected (unverified)', tone: 'warn' as const }
      : { label: 'Connected', tone: 'ok' as const }
    : { label: 'Not connected', tone: 'off' as const };

  // The wp-admin look: the dashboard, and out of its way. Everything below is
  // still one click down, because unlike WordPress this integration has parts
  // that can be misconfigured and have to be reachable.
  const compact = layout === 'embed' && !detailsOpen;

  return (
    <div style={compact ? { ...styles.root, gap: 12 } : styles.root}>
      {compact && (
        <div style={{ ...styles.row, justifyContent: 'space-between' }}>
          <div style={{ ...styles.row, gap: 10, fontSize: 12.5, opacity: 0.75 }}>
            <strong style={{ fontSize: 13, opacity: 1 }}>Clarity Brand Agent</strong>
            <Chip {...connectionChip} />
            {status.projectId && <span>project {status.projectId}</span>}
          </div>
          <div style={styles.row}>
            <button style={styles.button} onClick={() => setDetailsOpen(true)}>
              Details
            </button>
            {sessionPath && (
              <button
                style={styles.button}
                onClick={async () => {
                  await fetch(sessionPath, { method: 'DELETE' });
                  setState('unauthorized');
                }}
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      )}

      {!compact && (
      <>
      <div style={{ ...styles.row, justifyContent: 'space-between' }}>
        <div style={styles.row}>
          <strong style={{ fontSize: 15 }}>Clarity Brand Agent</strong>
          <Chip {...connectionChip} />
          <Chip
            label={status.injectFrontendScript ? 'Widget published' : 'Widget not published'}
            tone={status.injectFrontendScript ? 'ok' : 'off'}
          />
          {!status.agentEnabled && <Chip label="Agent off" tone="warn" />}
          {status.secretAtRest === 'clear' && <Chip label="Secret stored in clear" tone="warn" />}
          {status.rateLimit === 'unkeyed' && <Chip label="Widget endpoints closed" tone="warn" />}
        </div>
        <div style={styles.row}>
          <button style={styles.button} onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          {sessionPath && (
            <button
              style={styles.button}
              onClick={async () => {
                await fetch(sessionPath, { method: 'DELETE' });
                setState('unauthorized');
              }}
            >
              Sign out
            </button>
          )}
        </div>
      </div>

      {layout === 'embed' && detailsOpen && (
        <div style={styles.row}>
          <button style={styles.button} onClick={() => setDetailsOpen(false)}>
            Hide details
          </button>
        </div>
      )}
      </>
      )}

      {!status.siteUrlLocked && (
        <div style={styles.notice}>
          <div style={styles.noticeTitle}>
            {status.siteUrl ? 'Change the domain this site answers on' : 'Confirm the domain this site answers on'}
          </div>
          <div style={styles.noticeBody}>
            It is the identity registered with Microsoft and the origin the Clarity dashboard calls back to prove
            you own the site, so it has to be the public URL, reachable from the internet — not a preview or a
            tunnel. Correct it here for as long as it stays editable: connecting freezes it, because the
            credential is bound to it.
          </div>
          <div style={styles.row}>
            <input
              style={{ ...styles.input, minWidth: 280 }}
              value={siteUrlDraft}
              onChange={(event) => setSiteUrlDraft(event.target.value)}
              placeholder="https://example.com"
              aria-label="Site URL"
            />
            <button
              style={styles.button}
              onClick={() => void act('set-site-url', { siteUrl: siteUrlDraft })}
              disabled={busy || !siteUrlDraft}
            >
              {status.siteUrl ? 'Update' : 'Confirm'}
            </button>
          </div>
        </div>
      )}

      {status.rateLimit === 'unkeyed' && (
        <div style={styles.notice}>
          <div style={styles.noticeTitle}>The widget endpoints are closed</div>
          <div style={styles.noticeBody}>
            <code>config/read</code> and <code>v1/init</code> are the two routes the public internet can drive,
            and they spend your Brand Agent quota. Throttling them needs to know who is calling, which only you
            can say: pass <code>rateLimit: {'{'} trustProxy: 1 {'}'}</code> if one reverse proxy sits in front of
            this app, <code>rateLimit: {'{'} clientIp {'}'}</code> to read the address from your host, or{' '}
            <code>rateLimit: false</code> to serve them unthrottled on purpose. Setup and connect work either
            way; the widget will not, until this is decided.
          </div>
        </div>
      )}

      {status.storage?.ephemeral && (
        <div style={styles.notice}>
          <div style={styles.noticeTitle}>Check that this survives a redeploy</div>
          <div style={styles.noticeBody}>
            The connection is stored in <code>{status.storage.location}</code>, inside the working directory. If
            this host rebuilds its filesystem on every release — most container platforms do — the HMAC secret
            goes with it and the site has to connect again. Point <code>storage</code> at a mounted volume to be
            sure. Nothing here can tell from the inside, so treat this as a question, not a verdict.
          </div>
        </div>
      )}

      {!compact && (
      <>
      <div style={styles.grid}>
        <Field label="Site URL" value={status.siteUrl} />
        <Field label="Client ID" value={status.clientId} />
        <Field label="Project" value={status.projectId} />
        <Field label="Site ID" value={status.siteId ?? ''} />
        <Field label="Advertiser" value={status.advertiserId ?? ''} />
        <Field label="Connected at" value={status.connectedAt ?? ''} />
      </div>

      <div style={styles.row}>
        <button style={styles.button} onClick={() => void act('connect')} disabled={busy || !status.siteUrl}>
          {status.connected ? 'Reconnect' : 'Connect'}
        </button>
        <button style={styles.button} onClick={() => void act('disconnect')} disabled={busy || !status.connected}>
          Disconnect
        </button>
        <button style={styles.button} onClick={() => void act('sync-content')} disabled={busy || !status.connected}>
          Sync content
        </button>
        <button
          style={styles.button}
          onClick={() => void act('set-inject', { enabled: !status.injectFrontendScript })}
          disabled={busy || !status.connected}
          title="Local override of the publish flag — the backend overwrites it on the next publish."
        >
          {status.injectFrontendScript ? 'Hide widget' : 'Force widget'}
        </button>
      </div>

      <div style={styles.row}>
        <input
          style={styles.input}
          value={projectDraft}
          placeholder="Clarity project id"
          onChange={(event) => setProjectDraft(event.target.value)}
        />
        <button style={styles.button} onClick={() => void act('set-project-id', { projectId: projectDraft })} disabled={busy}>
          Save project id
        </button>
      </div>

      {sessionPath && authInfo?.source === 'storage' && (
        <div style={styles.row}>
          {showPasswordChange ? (
            <form
              style={styles.row}
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                try {
                  const res = await fetch(sessionPath, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ currentPassword: password, newPassword }),
                  });
                  const data = (await res.json().catch(() => ({}))) as { error?: string };
                  if (res.ok) {
                    append('password changed', 'ok');
                    setShowPasswordChange(false);
                  } else {
                    append(data.error ?? 'Could not change the password.', 'error');
                  }
                } finally {
                  setPassword('');
                  setNewPassword('');
                  setBusy(false);
                }
              }}
            >
              <input
                style={styles.input}
                type="password"
                value={password}
                autoComplete="current-password"
                placeholder="Current password"
                onChange={(event) => setPassword(event.target.value)}
              />
              <input
                style={styles.input}
                type="password"
                value={newPassword}
                autoComplete="new-password"
                placeholder="New password (10+ characters)"
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <button style={styles.button} type="submit" disabled={busy}>
                Save
              </button>
              <button style={styles.button} type="button" onClick={() => setShowPasswordChange(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <button style={styles.button} onClick={() => setShowPasswordChange(true)}>
              Change admin password
            </button>
          )}
        </div>
      )}

      {log.length > 0 && (
        <div style={styles.log}>
          {log.map((entry, index) => (
            <div key={`${entry.at}-${index}`} style={{ color: entry.tone === 'error' ? '#ff8f8f' : entry.tone === 'ok' ? '#7ee49a' : 'inherit' }}>
              <span style={{ opacity: 0.5 }}>{entry.at}</span> {entry.message}
            </div>
          ))}
        </div>
      )}

      </>
      )}

      {showEmbed && embedUrl && (
        <iframe
          title="Microsoft Clarity"
          src={embedUrl}
          style={{ ...styles.iframe, height: embedHeight ?? (layout === 'embed' ? '100vh' : '760px') }}
          sandbox="allow-modals allow-forms allow-scripts allow-same-origin allow-popups allow-storage-access-by-user-activation"
        />
      )}
    </div>
  );
}

export default BrandAgentAdmin;
