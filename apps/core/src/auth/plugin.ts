import { type AuthState, ChangePasswordBody, CSRF_HEADER, LoginBody, SetupBody } from '@emberline/protocol';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type CoreConfig, normalizeHostName } from '../config.js';
import { type Db, getSetting, setSetting } from '../db/index.js';
import { conflict, HttpError } from '../errors.js';
import { ContainerAddresses } from './container-addresses.js';
import { SessionStore } from './sessions.js';

export const SESSION_COOKIE = 'emberline_session';
/** Over HTTPS the cookie carries the `__Host-` prefix: Secure, host-only, path `/` (S18). */
export const SECURE_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;
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
/** Across all clients: spoofed or rotating addresses cannot multiply the guesses (S12). */
const MAX_GLOBAL_FAILURES = 50;
const MAX_TRACKED_CLIENTS = 10_000;

/** Why a session cookie that exists is not accepted here; the login screen shows it. */
export const ADDRESS_CHANGED_MESSAGE = 'signed out: your network address changed';
export const FROM_CONTAINER_MESSAGE =
  "session cookies are not accepted from Emberline's own containers (an agent's preview could have replayed it)";

type SessionState = 'ok' | 'none' | 'address_changed' | 'from_container';

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

  const sessionToken = (request: FastifyRequest) =>
    request.cookies[SECURE_SESSION_COOKIE] ?? request.cookies[SESSION_COOKIE];

  // Cookies ignore ports: a browser sends the session cookie to every preview server on Emberline's
  // host, where agent-written code runs and could replay it to core (from the runner over
  // http://core:7420, or from the engine). The direct peer decides, whatever a proxy header says.
  const containers = new ContainerAddresses(config.containerHosts ?? []);
  app.addHook('onClose', async () => containers.stop());
  const bindIp = config.sessionBindIp ?? true;

  const sessionState = async (request: FastifyRequest): Promise<SessionState> => {
    const token = sessionToken(request);
    if (!token) return 'none';
    if (await containers.has(request.raw.socket.remoteAddress)) return 'from_container';
    return store.check(token, request.ip, bindIp);
  };

  const issueSession = (request: FastifyRequest, reply: FastifyReply) => {
    const { token, expiresAt } = store.create(request.headers['user-agent'], request.ip);
    // HTTPS is detected per request (X-Forwarded-Proto counts with EMBERLINE_TRUST_PROXY), so a TLS
    // proxy gets Secure cookies without extra configuration; plain-HTTP LAN access keeps working.
    const secure = config.secureCookies || request.protocol === 'https';
    reply.setCookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      expires: expiresAt,
    });
  };

  const hostAllowed = hostAllowList(config);
  app.addHook('onRequest', async (request, reply) => {
    // DNS rebinding: a page on evil.example that re-points its name at this machine would be
    // same-origin with us. Browsers still send the attacker's name as Host, so refuse unknown names
    // (this covers the API, the SPA and /metrics). IP literals cannot be rebound.
    if (!hostAllowed(request.host)) {
      return reply
        .code(421)
        .send({ error: 'misdirected_request', message: `Host "${request.host}" is not allowed. Add it to EMBERLINE_ALLOWED_HOSTS.` });
    }
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
    // Browsers always send Origin on WebSocket handshakes; a missing one is a non-browser client
    // that has no business holding a session cookie here.
    if (!origin && request.headers.upgrade?.toLowerCase() === 'websocket') {
      return reply.code(403).send({ error: 'forbidden', message: 'WebSocket upgrades need an Origin header' });
    }
    if (!SAFE_METHODS.has(request.method) && request.headers[CSRF_HEADER] !== '1') {
      return reply.code(403).send({ error: 'csrf', message: `missing ${CSRF_HEADER} header` });
    }
    if (PUBLIC_ROUTES.has(route)) return;
    const session = await sessionState(request);
    if (session === 'from_container') {
      return reply.code(403).send({ error: 'session_from_container', message: FROM_CONTAINER_MESSAGE });
    }
    if (session === 'address_changed') {
      return reply.code(401).send({ error: 'session_address_changed', message: ADDRESS_CHANGED_MESSAGE });
    }
    if (session !== 'ok') {
      return reply.code(401).send({ error: 'unauthorized', message: 'login required' });
    }
    // Terminals and the event stream stay open for hours: logout or a password change closes them.
    if (request.headers.upgrade?.toLowerCase() === 'websocket') {
      store.bindConnection(sessionToken(request)!, request.raw.socket);
    }
  });

  app.get('/api/auth/state', async (request): Promise<AuthState> => {
    const session = await sessionState(request);
    return {
      setupRequired: getSetting<string>(db, PASSWORD_KEY) === undefined,
      authenticated: session === 'ok',
      ...(session === 'address_changed' ? { signedOut: ADDRESS_CHANGED_MESSAGE } : {}),
    };
  });

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

  let globalFailures = { count: 0, since: 0 };

  /** Refuses with 429 (and Retry-After) while this client or all clients together failed too often. */
  const assertNotThrottled = (request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    const entry = failures.get(request.ip);
    const blockedUntil = Math.max(
      entry && now - entry.since < FAILURE_WINDOW_MS && entry.count >= MAX_FAILURES ? entry.since + FAILURE_WINDOW_MS : 0,
      now - globalFailures.since < FAILURE_WINDOW_MS && globalFailures.count >= MAX_GLOBAL_FAILURES
        ? globalFailures.since + FAILURE_WINDOW_MS
        : 0,
    );
    if (blockedUntil > now) {
      const minutes = Math.ceil((blockedUntil - now) / 60_000);
      reply.header('retry-after', String(Math.ceil((blockedUntil - now) / 1000)));
      throw new HttpError(
        429,
        'too_many_attempts',
        `too many failed attempts, try again in ${minutes} minute${minutes === 1 ? '' : 's'}`,
      );
    }
  };

  const recordFailure = (request: FastifyRequest) => {
    const now = Date.now();
    const entry = failures.get(request.ip);
    const fresh = !entry || now - entry.since >= FAILURE_WINDOW_MS;
    if (fresh && failures.size >= MAX_TRACKED_CLIENTS) {
      for (const [ip, e] of failures) if (now - e.since >= FAILURE_WINDOW_MS) failures.delete(ip);
    }
    failures.set(request.ip, fresh ? { count: 1, since: now } : { count: entry.count + 1, since: entry.since });
    globalFailures =
      now - globalFailures.since >= FAILURE_WINDOW_MS
        ? { count: 1, since: now }
        : { count: globalFailures.count + 1, since: globalFailures.since };
  };

  app.post('/api/auth/login', async (request, reply) => {
    assertNotThrottled(request, reply);
    const { password } = LoginBody.parse(request.body);
    const stored = getSetting<string>(db, PASSWORD_KEY);
    if (!stored) throw new HttpError(409, 'setup_required', 'run first-time setup first');

    if (!(await verify(stored, password))) {
      recordFailure(request);
      throw new HttpError(401, 'invalid_password', 'invalid password');
    }
    failures.delete(request.ip);
    issueSession(request, reply);
    return { ok: true };
  });

  // Changing the password ends every session (other browsers, stolen cookies) and signs this one in again.
  app.post('/api/auth/password', async (request, reply) => {
    assertNotThrottled(request, reply);
    const { currentPassword, newPassword } = ChangePasswordBody.parse(request.body);
    const stored = getSetting<string>(db, PASSWORD_KEY);
    if (!stored) throw new HttpError(409, 'setup_required', 'run first-time setup first');
    if (!(await verify(stored, currentPassword))) {
      recordFailure(request);
      throw new HttpError(403, 'invalid_password', 'current password is incorrect');
    }
    setSetting(db, PASSWORD_KEY, await hash(newPassword));
    store.revokeAll();
    issueSession(request, reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    store.revoke(sessionToken(request));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    if (request.cookies[SECURE_SESSION_COOKIE] !== undefined) {
      reply.clearCookie(SECURE_SESSION_COOKIE, { path: '/', secure: true });
    }
    return { ok: true };
  });

  return store;
}

function hostAllowList(config: CoreConfig): (host: string) => boolean {
  const names = new Set(['localhost', ...config.allowedHosts]);
  try {
    names.add(normalizeHostName(new URL(config.hookUrl).host));
  } catch {
    // an unparsable hook URL adds nothing
  }
  const any = names.has('*');
  return (host) => {
    if (any || host === '') return true;
    const name = normalizeHostName(host);
    return isIP(name) !== 0 || names.has(name);
  };
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
