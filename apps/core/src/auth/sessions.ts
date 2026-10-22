import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { eq, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const sameHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * `ok`; `none`: no valid session; `address_changed`: the session belongs to another client address;
 * `key_missing`: the request needs the per-login key and did not send this session's, or the session
 * is from before 0.5.0 and has none (the person signs in once).
 */
export type SessionCheck = 'ok' | 'none' | 'address_changed' | 'key_missing';

/** `::ffff:1.2.3.4` and `1.2.3.4` are the same client. */
export function normalizeIp(ip: string | undefined): string {
  const value = (ip ?? '').trim().toLowerCase();
  return value.startsWith('::ffff:') && value.includes('.') ? value.slice(7) : value;
}

/** Opaque random session tokens; only their SHA-256 is persisted. */
export class SessionStore {
  /** Upgraded (WebSocket) connections per session, closed when that session ends (S18). */
  private readonly liveConnections = new Map<string, Set<Socket>>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs: number,
  ) {}

  /** A new session: the cookie `token` and the per-login `key` the browser keeps; only their SHA-256 is stored. */
  create(userAgent: string | undefined, clientIp: string): { token: string; key: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    const key = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(now + this.ttlMs);
    this.db
      .insert(sessions)
      .values({
        id: hashToken(token),
        createdAt: new Date(now),
        expiresAt,
        userAgent: userAgent?.slice(0, 512),
        clientIp: normalizeIp(clientIp),
        keyHash: hashToken(key),
      })
      .run();
    return { token, key, expiresAt };
  }

  /**
   * Whether `token` is a live session for a request from `clientIp`. `key` is the per-login key the
   * request sent: `undefined` when the request needs none (a plain GET), `null` when it needs one
   * and sent none. A session without a key (from before 0.5.0) is refused either way. With `bindIp`,
   * the session must also come from the address that signed in; a session from before addresses
   * were recorded is ended (the person signs in once). A mismatch leaves the session alone: its
   * owner keeps it.
   */
  check(
    token: string | undefined,
    clientIp: string,
    { bindIp = true, key }: { bindIp?: boolean; key?: string | null } = {},
  ): SessionCheck {
    if (!token) return 'none';
    const id = hashToken(token);
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row) return 'none';
    if (row.expiresAt.getTime() <= Date.now()) {
      this.db.delete(sessions).where(eq(sessions.id, id)).run();
      return 'none';
    }
    if (row.keyHash === null) return 'key_missing';
    if (key !== undefined && !sameHash(row.keyHash, hashToken(key ?? ''))) return 'key_missing';
    if (!bindIp) return 'ok';
    if (row.clientIp === null) {
      this.db.delete(sessions).where(eq(sessions.id, id)).run();
      return 'none';
    }
    return row.clientIp === normalizeIp(clientIp) ? 'ok' : 'address_changed';
  }

  revoke(token: string | undefined): void {
    if (!token) return;
    const id = hashToken(token);
    this.db.delete(sessions).where(eq(sessions.id, id)).run();
    this.dropConnections(id);
  }

  /** Ends every session (after a password change or reset). */
  revokeAll(): void {
    this.db.delete(sessions).run();
    for (const id of [...this.liveConnections.keys()]) this.dropConnections(id);
  }

  /** Ties a long-lived connection (terminal, event stream) to the session that opened it. */
  bindConnection(token: string, socket: Socket): void {
    const id = hashToken(token);
    let set = this.liveConnections.get(id);
    if (!set) {
      set = new Set();
      this.liveConnections.set(id, set);
    }
    set.add(socket);
    socket.once('close', () => {
      const current = this.liveConnections.get(id);
      current?.delete(socket);
      if (current?.size === 0) this.liveConnections.delete(id);
    });
  }

  private dropConnections(id: string): void {
    const set = this.liveConnections.get(id);
    if (!set) return;
    this.liveConnections.delete(id);
    for (const socket of set) socket.destroy();
  }

  purgeExpired(): void {
    this.db.delete(sessions).where(lt(sessions.expiresAt, new Date())).run();
  }
}
