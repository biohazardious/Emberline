import type { FastifyInstance } from 'fastify';
import { hostNameOf } from './runs/preview-url.js';

/** Default request body cap; routes that accept uploads raise it per route. */
export const DEFAULT_BODY_LIMIT = 1024 * 1024;
/** Upload routes (base64 attachments and workspace uploads). */
export const UPLOAD_BODY_LIMIT = 128 * 1024 * 1024;
/** Editor saves: up to 2M characters, which can be ~4x that in UTF-8 plus JSON escaping. */
export const EDITOR_BODY_LIMIT = 16 * 1024 * 1024;

/**
 * Policy for the web UI. Monaco injects `<style>` elements and runs its workers from blob URLs;
 * the Inter / JetBrains Mono web fonts come from Google Fonts;
 * the demo and artifact iframes are same-origin but sandboxed by their own response CSP.
 * {@link appCsp} adds the host of the container previews to `frame-src`.
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

/**
 * Where the browser opens previews, as a CSP source on any port: `EMBERLINE_PREVIEW_HOST`'s host,
 * else the host the page was requested on (the same rule as `previewUrl`). Null when neither is a
 * plain http(s) host name, so nothing malformed reaches the policy.
 */
export function previewFrameSource(hostHeader: string | undefined, override = process.env.EMBERLINE_PREVIEW_HOST): string | null {
  const base = override?.trim();
  if (base) {
    try {
      const url = new URL(base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return hostSource(url.protocol, hostNameOf(url.hostname));
    } catch {
      return null;
    }
  }
  return hostSource('http:', hostNameOf(hostHeader));
}

/** `scheme//name:*`; null for no name or an IPv6 literal, which CSP host sources cannot express. */
function hostSource(protocol: string, name: string | null): string | null {
  return name && !name.startsWith('[') ? `${protocol}//${name}:*` : null;
}

/**
 * The web UI's policy for one request: {@link APP_CSP}, with the container previews' host in
 * `frame-src` so Preview & Build can show a preview, which answers on its own port.
 */
export function appCsp(hostHeader: string | undefined): string {
  const preview = previewFrameSource(hostHeader);
  return preview ? APP_CSP.replace("frame-src 'self'", `frame-src 'self' ${preview}`) : APP_CSP;
}

/**
 * For agent-written HTML/SVG served from core (live demo, artifacts, inline downloads). The
 * `sandbox` directive gives the document an opaque origin, so its scripts cannot read the
 * Emberline origin or send authenticated API requests.
 */
export const UNTRUSTED_CONTENT_CSP =
  'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock';

export function installSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    if (!reply.hasHeader('content-security-policy')) {
      const type = String(reply.getHeader('content-type') ?? '');
      if (type.startsWith('text/html')) {
        // request.host: allow-listed by the auth hook, and the forwarded host behind a trusted proxy.
        reply.header('content-security-policy', appCsp(request.host));
        reply.header('x-frame-options', 'SAMEORIGIN');
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
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
