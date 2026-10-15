import { type AuthState, CSRF_HEADER, LoginBody, SetupBody } from '@emberline/protocol';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CoreConfig } from '../config.js';
import { type Db, getSetting, setSetting } from '../db/index.js';
import { conflict, HttpError } from '../errors.js';
import { SessionStore } from './sessions.js';

export const SESSION_COOKIE = 'emberline_session';
const PASSWORD_KEY = 'auth.passwordHash';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_ROUTES = new Set([
  '/api/health',
  '/api/health/deep',
  '/api/auth/state',
  '/api/auth/setup',
  '/api/auth/login',
]);
/** Machine-to-machine routes (runner -> core) that carry their own credentials. */
const INTERNAL_PREFIX = '/api/internal/';
/**
 * Live demo assets, authorized by the signed capability token in their path. They are requested by
 * sandboxed (opaque-origin, `Origin: null`) documents and by the runner's browser, neither of
 * which carries a session.
 */
const DEMO_ASSET_ROUTES = new Set(['/api/demo/:token', '/api/demo/:token/*']);

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60_000;

/**
 * Single-user auth (PROJECT.md §3.13).
 *
 * - Password hashed with argon2id, set once during first-run setup.
 * - HTTP-only, SameSite=Lax session cookie.
 * - CSRF: mutating /api requests must send `x-emberline-csrf: 1` (a custom header cannot be sent
 *   cross-origin without a CORS preflight, which core never allows) and any Origin header must
 *   match the Host. WebSocket upgrades are GETs, so the Origin check also blocks cross-site
 *   WebSocket hijacking.
 */
export function registerAuth(app: FastifyInstance, { db, config }: { db: Db; config: CoreConfig }): SessionStore {
  const store = new SessionStore(db, config.sessionTtlMs);
  store.purgeExpired();
  const failures = new Map<string, { count: number; since: number }>();

  // Without this, whoever reaches a fresh instance first (a LAN peer, an agent in the runner, a
  // DNS-rebinding page) could claim it.
  const setupToken = config.setupToken ?? randomBytes(18).toString('base64url');
  if (getSetting<string>(db, PASSWORD_KEY) === undefined) {
    app.log.warn(`First-run setup token: ${setupToken} (enter it on the setup page)`);
  }

  const isAuthenticated = (request: FastifyRequest) => store.validate(request.cookies[SESSION_COOKIE]);

  const issueSession = (request: FastifyRequest, reply: FastifyReply) => {
    const { token, expiresAt } = store.create(request.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      path: '/',
      expires: expiresAt,
    });
  };

  app.addHook('onRequest', async (request, reply) => {
    // Absolute-form targets (`GET http://host/api/...`) are only meant for proxies.
    if (!request.raw.url?.startsWith('/')) {
      return reply.code(400).send({ error: 'bad_request', message: 'origin-form request target required' });
    }
    // Decide on the route pattern the router actually matched, never on the raw URL: the router
    // percent-decodes paths, so `/%61pi/...` reaches `/api/...` handlers. Unmatched requests only
    // reach the 404 / SPA fallback handler.
    const route = request.routeOptions.url;
    if (!route?.startsWith('/api/')) return;
    if (route.startsWith(INTERNAL_PREFIX)) return;
    if (SAFE_METHODS.has(request.method) && DEMO_ASSET_ROUTES.has(route)) return;

    const origin = request.headers.origin;
    if (origin && !sameHost(origin, request.host)) {
      return reply.code(403).send({ error: 'forbidden', message: 'cross-origin request rejected' });
    }
    if (!SAFE_METHODS.has(request.method) && request.headers[CSRF_HEADER] !== '1') {
      return reply.code(403).send({ error: 'csrf', message: `missing ${CSRF_HEADER} header` });
    }
    if (PUBLIC_ROUTES.has(route)) return;
    if (!isAuthenticated(request)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'login required' });
    }
  });

  app.get('/api/auth/state', async (request): Promise<AuthState> => ({
    setupRequired: getSetting<string>(db, PASSWORD_KEY) === undefined,
    authenticated: isAuthenticated(request),
  }));

  app.post('/api/auth/setup', async (request, reply) => {
    if (getSetting<string>(db, PASSWORD_KEY) !== undefined) throw conflict('setup already completed');
    const { password, setupToken: provided } = SetupBody.parse(request.body);
    if (!sameSecret(provided, setupToken)) {
      throw new HttpError(403, 'forbidden', 'invalid setup token (see the core log)');
    }
    setSetting(db, PASSWORD_KEY, await hash(password));
    issueSession(request, reply);
    return { ok: true };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const key = request.ip;
    const now = Date.now();
    const entry = failures.get(key);
    if (entry && now - entry.since < FAILURE_WINDOW_MS && entry.count >= MAX_FAILURES) {
      throw new HttpError(429, 'too_many_attempts', 'too many failed attempts, try again later');
    }

    const { password } = LoginBody.parse(request.body);
    const stored = getSetting<string>(db, PASSWORD_KEY);
    if (!stored) throw new HttpError(409, 'setup_required', 'run first-time setup first');

    if (!(await verify(stored, password))) {
      const fresh = !entry || now - entry.since >= FAILURE_WINDOW_MS;
      failures.set(key, fresh ? { count: 1, since: now } : { count: entry.count + 1, since: entry.since });
      throw new HttpError(401, 'invalid_password', 'invalid password');
    }
    failures.delete(key);
    issueSession(request, reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    store.revoke(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  return store;
}

function sameHost(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
