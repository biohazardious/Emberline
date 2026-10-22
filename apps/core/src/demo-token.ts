import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Db, getSetting, setSetting } from './db/index.js';

const SECRET_KEY = 'demo.tokenSecret';

/** Browser sessions get a fresh token on every visit through the authenticated demo route. */
export const UI_DEMO_TOKEN_TTL_MS = 12 * 60 * 60_000;
/** Agents keep using `$EMBERLINE_DEMO_URL` for the whole life of a run. */
export const AGENT_DEMO_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;

export interface DemoTarget {
  projectId: string;
  targetId: string;
}

interface DemoTokenPayload {
  p: string;
  t: string;
  e: number;
}

/**
 * Capability tokens for the live demo. Demo documents run sandboxed with an opaque origin, so their
 * asset requests carry no session cookie; the signed token in the path authorizes them instead.
 */
export class DemoTokens {
  private secret: Buffer | undefined;

  constructor(private readonly db: Db) {}

  mint(target: DemoTarget, ttlMs: number, now = Date.now()): string {
    const payload: DemoTokenPayload = { p: target.projectId, t: target.targetId, e: now + ttlMs };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  verify(token: string, now = Date.now()): DemoTarget | null {
    const [body, sig, extra] = token.split('.');
    if (!body || !sig || extra !== undefined) return null;
    const expected = Buffer.from(this.sign(body));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    try {
      const payload = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as Partial<DemoTokenPayload>;
      if (typeof payload.p !== 'string' || typeof payload.t !== 'string' || typeof payload.e !== 'number') {
        return null;
      }
      if (payload.e <= now) return null;
      return { projectId: payload.p, targetId: payload.t };
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key()).update(body).digest('base64url');
  }

  private key(): Buffer {
    if (!this.secret) {
      let hex = getSetting<string>(this.db, SECRET_KEY);
      if (!hex) {
        hex = randomBytes(32).toString('hex');
        setSetting(this.db, SECRET_KEY, hex);
      }
      this.secret = Buffer.from(hex, 'hex');
    }
    return this.secret;
  }
}

export function demoBasePath(token: string): string {
  return `/api/demo/${token}/`;
}
