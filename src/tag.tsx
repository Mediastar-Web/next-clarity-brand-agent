/**
 * The Clarity analytics tag — the other half of what the WordPress plugin does.
 *
 * The Brand Agent is configured from a Clarity project, and that project only
 * comes alive once the site is actually sending Clarity traffic. The plugin
 * prints this snippet in `wp_head` as soon as a project id is set; this is the
 * same snippet, same loader, same `ref` attribution.
 *
 * No `use client` directive: it renders an inline script, so it works from a
 * server layout and ships no JavaScript bundle of its own.
 */

export interface ClarityTagProps {
  /** Clarity project id. Nothing renders without it. */
  projectId?: string | null;
  /**
   * Attribution passed to the tag loader. The plugin sends `wordpress`, and
   * since the rest of this integration presents itself as the WordPress plugin,
   * keeping it consistent is the safer default.
   */
  ref?: string;
}

export function ClarityTag({ projectId, ref: attribution = 'wordpress' }: ClarityTagProps) {
  if (!projectId || !/^[a-zA-Z0-9]+$/.test(projectId)) return null;

  // Both values end up inside a script body, so neither is interpolated raw:
  // the attribution is percent-encoded for the query string it lands in, then
  // both are serialized as JavaScript literals. A `ref` taken from a request or
  // from configuration therefore cannot close the string and run code.
  const ref = JSON.stringify(encodeURIComponent(attribution));
  const project = JSON.stringify(projectId);

  const snippet = `(function(c,l,a,r,i,t,y){
c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i+"?ref="+${ref};
y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
})(window, document, "clarity", "script", ${project});`;

  return <script id="microsoft-clarity" dangerouslySetInnerHTML={{ __html: snippet }} />;
}

export default ClarityTag;
