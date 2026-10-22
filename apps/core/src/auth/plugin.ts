import {
  type AuthState,
  ChangePasswordBody,
  CSRF_HEADER,
  LoginBody,
  SESSION_KEY_MISSING_MESSAGE,
  SESSION_KEY_PROTOCOL_PREFIX,
  type SessionIssued,
  SetupBody,
} from '@emberline/protocol';
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

type SessionState = 'ok' | 'none' | 'address_changed' | 'key_missing' | 'from_container';

const isUpgrade = (r: FastifyRequest) => r.headers.upgrade?.toLowerCase() === 'websocket';
/** The per-login key: the CSRF header value, or on a WebSocket upgrade the `emberline.key.*` subprotocol. */
const presentedKey = (r: FastifyRequest): string | undefined => {
  if (isUpgrade(r)) {
    const offered = String(r.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim());
    return (
      offered
        .find((p) => p.startsWith(SESSION_KEY_PROTOCOL_PREFIX))
        ?.slice(SESSION_KEY_PROTOCOL_PREFIX.length) || undefined
    );
  }
  const v = r.headers[CSRF_HEADER];
  return typeof v === 'string' && v !== '' ? v : undefined;
};

/**
 * Single-user auth (PROJECT.md §3.13).
 *
 * - Password hashed with argon2id, set once during first-run setup.
 * - HTTP-only, SameSite=Lax session cookie.
 * - CSRF: mutating /api requests must send the `x-emberline-csrf` header (a custom header cannot
 *   be sent cross-origin without a CORS preflight, which core never allows) and any Origin header
 *   must match the Host. WebSocket upgrades are GETs, so the Origin check also blocks cross-site
 *   WebSocket hijacking.
 * - Per-login key (0.5.0): setup, login and a password change answer a random `sessionKey` that the
 *   browser keeps in localStorage; only its SHA-256 is stored, and it is never logged. Signed in,
 *   every non-GET request sends it as the `x-emberline-csrf` value and every WebSocket upgrade as
 *   the subprotocol `emberline.key.<key>` (never in a URL, which proxies log). A plain GET is
 *   authorised by the cookie alone (navigation, images, frames, downloads). A cookie without its key
 *   is refused with `session_key_missing`, so a stolen cookie cannot change anything. A session
 *   from before 0.5.0 has no key and is refused on every request: the person signs in once. The key
 *   is checked whether or not sessions are bound to the address (`EMBERLINE_SESSION_BIND_IP`).
 * - A sign-in ends the sessions its request's cookies name (this browser's older one, whichever
 *   address it came from); other devices keep theirs.
 */
export function registerAuth(
  app: FastifyInstance,
  { db, config }: { db: Db; config: CoreConfig },
): SessionStore {
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
  const containers = new ContainerAddresses(config.containerHosts ?? [], {
    containerNetworks: config.containerNetworks ?? [],
  });
  app.addHook('onClose', async () => containers.stop());
  const bindIp = config.sessionBindIp ?? true;

  /** `key`: the per-login key the request sent; `undefined` when it needs none, `null` when it needs one and sent none. */
  const sessionState = async (request: FastifyRequest, key?: string | null): Promise<SessionState> => {
    const token = sessionToken(request);
    if (!token) return 'none';
    if (await containers.has(request.raw.socket.remoteAddress)) return 'from_container';
    return store.check(token, request.ip, { bindIp, key });
  };

  /** Signs this browser in again and returns the new per-login key for the response body. */
  const issueSession = (request: FastifyRequest, reply: FastifyReply): string => {
    // This browser's previous session (address changed, from before the key, or still live) ends
    // here, with its WebSockets: whoever gets that address next cannot use its cookie.
    store.revoke(request.cookies[SECURE_SESSION_COOKIE]);
    store.revoke(request.cookies[SESSION_COOKIE]);
    const { token, key, expiresAt } = store.create(request.headers['user-agent'], request.ip);
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
    return key;
  };

  const hostAllowed = hostAllowList(config);
  app.addHook('onRequest', async (request, reply) => {
    // DNS rebinding: a page on evil.example that re-points its name at this machine would be
    // same-origin with us. Browsers still send the attacker's name as Host, so refuse unknown names
    // (this covers the API, the SPA and /metrics). IP literals cannot be rebound.
    if (!hostAllowed(request.host)) {
      return reply.code(421).send({
        error: 'misdirected_request',
        message: `Host "${request.host}" is not allowed. Add it to EMBERLINE_ALLOWED_HOSTS.`,
      });
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
    if (!origin && isUpgrade(request)) {
      return reply
        .code(403)
        .send({ error: 'forbidden', message: 'WebSocket upgrades need an Origin header' });
    }
    // Presence only: any value makes a cross-origin request need a preflight. Signed in, the value
    // must be the session's key (checked below).
    if (!SAFE_METHODS.has(request.method) && !request.headers[CSRF_HEADER]) {
      return reply.code(403).send({ error: 'csrf', message: `missing ${CSRF_HEADER} header` });
    }
    if (PUBLIC_ROUTES.has(route)) return;
    const needsKey = !SAFE_METHODS.has(request.method) || isUpgrade(request);
    const session = await sessionState(request, needsKey ? (presentedKey(request) ?? null) : undefined);
    if (session === 'from_container') {
      return reply.code(403).send({ error: 'session_from_container', message: FROM_CONTAINER_MESSAGE });
    }
    if (session === 'address_changed') {
      return reply.code(401).send({ error: 'session_address_changed', message: ADDRESS_CHANGED_MESSAGE });
    }
    if (session === 'key_missing') {
      return reply.code(401).send({ error: 'session_key_missing', message: SESSION_KEY_MISSING_MESSAGE });
    }
    if (session !== 'ok') {
      return reply.code(401).send({ error: 'unauthorized', message: 'login required' });
    }
    // Terminals and the event stream stay open for hours: logout, a new sign-in from this browser or
    // a password change closes them.
    if (isUpgrade(request)) {
      store.bindConnection(sessionToken(request)!, request.raw.socket);
    }
  });

  app.get('/api/auth/state', async (request): Promise<AuthState> => {
    // A key the browser sends is checked; without one the answer says whether the cookie alone is
    // valid, and the web app asks for a sign-in when it holds no key.
    const session = await sessionState(request, presentedKey(request));
    return {
      setupRequired: getSetting<string>(db, PASSWORD_KEY) === undefined,
      authenticated: session === 'ok',
      ...(session === 'address_changed' ? { signedOut: ADDRESS_CHANGED_MESSAGE } : {}),
      ...(session === 'key_missing' ? { signedOut: SESSION_KEY_MISSING_MESSAGE } : {}),
    };
  });

  app.post('/api/auth/setup', async (request, reply) => {
    if (getSetting<string>(db, PASSWORD_KEY) !== undefined) throw conflict('setup already completed');
    const { password, setupToken: provided } = SetupBody.parse(request.body);
    if (!sameSecret(provided, setupToken)) {
      throw new HttpError(403, 'forbidden', 'invalid setup token (see the core log)');
    }
    setSetting(db, PASSWORD_KEY, await hash(password));
    return { ok: true, sessionKey: issueSession(request, reply) } satisfies SessionIssued;
  });

  let globalFailures = { count: 0, since: 0 };

  /** Refuses with 429 (and Retry-After) while this client or all clients together failed too often. */
  const assertNotThrottled = (request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    const entry = failures.get(request.ip);
    const blockedUntil = Math.max(
      entry && now - entry.since < FAILURE_WINDOW_MS && entry.count >= MAX_FAILURES
        ? entry.since + FAILURE_WINDOW_MS
        : 0,
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
    failures.set(
      request.ip,
      fresh ? { count: 1, since: now } : { count: entry.count + 1, since: entry.since },
    );
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
    return { ok: true, sessionKey: issueSession(request, reply) } satisfies SessionIssued;
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
    return { ok: true, sessionKey: issueSession(request, reply) } satisfies SessionIssued;
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
  // The runner reaches core by the hook URL's name and, for the git gateway, by that URL's name.
  for (const url of [config.hookUrl, config.gitGatewayUrl]) {
    try {
      if (url) names.add(normalizeHostName(new URL(url).host));
    } catch {
      // an unparsable URL adds nothing
    }
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
