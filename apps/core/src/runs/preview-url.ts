/**
 * Where the browser opens a preview: the host it used for the API (already checked against the
 * allow-list by the auth hook) on the preview's published port, unless `EMBERLINE_PREVIEW_HOST` is
 * set. Previews are plain HTTP on their own port, whatever scheme the API came over.
 */

/** The host name of a Host header (`name`, `1.2.3.4`, `[::1]`, each with an optional port); null if malformed. */
export function hostNameOf(hostHeader: string | undefined): string | null {
  const host = hostHeader?.trim().toLowerCase();
  if (!host) return null;
  const v6 = /^(\[[0-9a-f:.]+\])(?::\d{1,5})?$/.exec(host);
  if (v6) return v6[1]!;
  const name = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\.?(?::\d{1,5})?$/.exec(host);
  return name ? name[1]! : null;
}

export function previewUrl(port: number, requestHost?: string, override = process.env.EMBERLINE_PREVIEW_HOST): string {
  const base = override?.trim();
  if (base) return `${base.replace(/\/+$/, '')}:${port}`;
  return `http://${hostNameOf(requestHost) ?? 'localhost'}:${port}`;
}
