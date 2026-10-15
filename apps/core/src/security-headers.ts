import type { FastifyInstance } from 'fastify';

/** Default request body cap; routes that accept uploads raise it per route. */
export const DEFAULT_BODY_LIMIT = 1024 * 1024;
/** Upload routes (base64 attachments and workspace uploads). */
export const UPLOAD_BODY_LIMIT = 128 * 1024 * 1024;
/** Editor saves: up to 2M characters, which can be ~4x that in UTF-8 plus JSON escaping. */
export const EDITOR_BODY_LIMIT = 16 * 1024 * 1024;

/**
 * Policy for the web UI. Monaco injects `<style>` elements and runs its workers from blob URLs;
 * the demo and artifact iframes are same-origin but sandboxed by their own response CSP.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/**
 * For agent-written HTML/SVG served from core (live demo, artifacts, inline downloads). The
 * `sandbox` directive gives the document an opaque origin, so its scripts cannot read the
 * Emberline origin or send authenticated API requests.
 */
export const UNTRUSTED_CONTENT_CSP = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads';

export function installSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    if (!reply.hasHeader('content-security-policy')) {
      const type = String(reply.getHeader('content-type') ?? '');
      if (type.startsWith('text/html')) {
        reply.header('content-security-policy', APP_CSP);
        reply.header('x-frame-options', 'SAMEORIGIN');
      }
    }
    return payload;
  });
}
