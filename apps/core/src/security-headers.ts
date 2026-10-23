import { base64Length, MATERIALS_MAX_TOTAL_BYTES } from '@emberline/protocol';
import type { FastifyInstance } from 'fastify';
import type { CoreConfig } from './config.js';
import { hostNameOf } from './runs/preview-url.js';

/** Default request body cap; routes that accept uploads raise it per route. */
export const DEFAULT_BODY_LIMIT = 1024 * 1024;
/** `POST /api/projects`: the wizard's reference files (30 MB as base64) plus room for the rest of the body. */
export const PROJECT_CREATE_BODY_LIMIT = base64Length(MATERIALS_MAX_TOTAL_BYTES) + 2 * DEFAULT_BODY_LIMIT;
/** Upload routes (base64 attachments and workspace uploads). */
export const UPLOAD_BODY_LIMIT = 128 * 1024 * 1024;
/** Editor saves: up to 2M characters, which can be ~4x that in UTF-8 plus JSON escaping. */
export const EDITOR_BODY_LIMIT = 16 * 1024 * 1024;

/**
 * Policy for the web UI. Monaco injects `<style>` elements and runs its workers from blob URLs;
 * the Inter / JetBrains Mono web fonts come from Google Fonts;
 * the demo and artifact iframes are same-origin but sandboxed by their own response CSP.
 * {@link appCsp} adds the container previews' host and ports to `frame-src`.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** Above this many preview ports, `frame-src` names the preview host on any port instead of each port. */
export const MAX_LISTED_PREVIEW_PORTS = 100;
/**
 * The longest web UI policy with each preview port listed; a longer one names the preview host on
 * any port instead. nginx's default `proxy_buffer_size` (4 KB) has to hold every response header,
 * so the policy leaves 1 KB of it for the rest.
 */
export const MAX_APP_CSP_BYTES = 3 * 1024;

/** Every preview port of both ranges, sorted and once each; null when there are more than {@link MAX_LISTED_PREVIEW_PORTS}. */
export function previewPortList(ports: CoreConfig['previewPorts']): number[] | null {
  const all = new Set<number>();
  for (const range of [ports.runner, ports.docker]) {
    for (let port = range.first; port <= range.last; port++) {
      all.add(port);
      if (all.size > MAX_LISTED_PREVIEW_PORTS) return null;
    }
  }
  return [...all].sort((a, b) => a - b);
}

/**
 * Where the browser opens previews, as CSP sources: `EMBERLINE_PREVIEW_HOST`'s host, else the host
 * the page was requested on (the same rule as `previewUrl`), on each preview port (any port above
 * {@link MAX_LISTED_PREVIEW_PORTS}, or when the list would take the policy past
 * {@link MAX_APP_CSP_BYTES}). A CSP host source cannot name an IPv6 literal, so that host gets
 * its scheme (`http:`; the preview panel says so). Empty when neither is a plain http(s) host, so
 * nothing malformed reaches the policy.
 */
export function previewFrameSources(
  hostHeader: string | undefined,
  ports: CoreConfig['previewPorts'],
  override = process.env.EMBERLINE_PREVIEW_HOST,
): string[] {
  return frameSources(hostHeader, ports, override).sources;
}

/**
 * Whether the preview ports, at most {@link MAX_LISTED_PREVIEW_PORTS} of them, are not listed
 * because listing them would take the policy past {@link MAX_APP_CSP_BYTES} (a long host name).
 */
export function previewFrameTooLong(
  hostHeader: string | undefined,
  ports: CoreConfig['previewPorts'],
  override = process.env.EMBERLINE_PREVIEW_HOST,
): boolean {
  return frameSources(hostHeader, ports, override).tooLong;
}

function frameSources(
  hostHeader: string | undefined,
  ports: CoreConfig['previewPorts'],
  override: string | undefined,
): { sources: string[]; tooLong: boolean } {
  const host = previewHost(hostHeader, override);
  if (!host) return { sources: [], tooLong: false };
  if (host.name.startsWith('[')) return { sources: [host.protocol], tooLong: false };
  const anyPort = [`${host.protocol}//${host.name}:*`];
  const list = previewPortList(ports);
  if (!list) return { sources: anyPort, tooLong: false };
  const listed = list.map((port) => `${host.protocol}//${host.name}:${port}`);
  // `frame-src 'self'` gains a space and the sources.
  const policyBytes = Buffer.byteLength(APP_CSP) + 1 + Buffer.byteLength(listed.join(' '));
  return policyBytes > MAX_APP_CSP_BYTES
    ? { sources: anyPort, tooLong: true }
    : { sources: listed, tooLong: false };
}

/** The scheme and host name previews open on; null when it is not a plain http(s) host. */
function previewHost(
  hostHeader: string | undefined,
  override: string | undefined,
): { protocol: string; name: string } | null {
  const base = override?.trim();
  if (base) {
    try {
      const url = new URL(base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      const name = hostNameOf(url.hostname);
      return name ? { protocol: url.protocol, name } : null;
    } catch {
      return null;
    }
  }
  const name = hostNameOf(hostHeader);
  return name ? { protocol: 'http:', name } : null;
}

/**
 * The web UI's policy for one request: {@link APP_CSP}, with the container previews' host and ports
 * in `frame-src` so Preview & Build can show a preview, which answers on its own port.
 */
export function appCsp(hostHeader: string | undefined, ports: CoreConfig['previewPorts']): string {
  const sources = previewFrameSources(hostHeader, ports);
  return sources.length > 0
    ? APP_CSP.replace("frame-src 'self'", `frame-src 'self' ${sources.join(' ')}`)
    : APP_CSP;
}

/**
 * For agent-written HTML/SVG served from core (live demo, artifacts, inline downloads). The
 * `sandbox` directive gives the document an opaque origin, so its scripts cannot read the
 * Emberline origin or send authenticated API requests.
 */
export const UNTRUSTED_CONTENT_CSP =
  'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock';

export function installSecurityHeaders(app: FastifyInstance, ports: CoreConfig['previewPorts']): void {
  // With EMBERLINE_PREVIEW_HOST every page gets the same policy, and core's start says so already.
  let toldTooLong = false;
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    if (!reply.hasHeader('content-security-policy')) {
      const type = String(reply.getHeader('content-type') ?? '');
      if (type.startsWith('text/html')) {
        // request.host: allow-listed by the auth hook, and the forwarded host behind a trusted proxy.
        reply.header('content-security-policy', appCsp(request.host, ports));
        reply.header('x-frame-options', 'SAMEORIGIN');
        if (
          !toldTooLong &&
          !process.env.EMBERLINE_PREVIEW_HOST?.trim() &&
          previewFrameTooLong(request.host, ports)
        ) {
          toldTooLong = true;
          request.log.warn(
            { host: request.host },
            'Listing the preview ports for this host name would make the frame policy longer than 3 KB, so it allows every port on the preview host.',
          );
        }
      }
    }
    return payload;
  });
}

/**
 * Content-Disposition for a file name from the workspace (agents choose it): an ASCII fallback
 * plus the RFC 5987 UTF-8 form, so any name yields a valid header value.
 */
export function contentDisposition(kind: 'attachment' | 'inline', fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
