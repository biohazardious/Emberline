import { createHash, randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import { eq, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Opaque random session tokens; only their SHA-256 is persisted. */
export class SessionStore {
  /** Upgraded (WebSocket) connections per session, closed when that session ends (S18). */
  private readonly liveConnections = new Map<string, Set<Socket>>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs: number,
  ) {}

  create(userAgent?: string): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(now + this.ttlMs);
    this.db
      .insert(sessions)
      .values({ id: hashToken(token), createdAt: new Date(now), expiresAt, userAgent: userAgent?.slice(0, 512) })
      .run();
    return { token, expiresAt };
  }

  validate(token: string | undefined): boolean {
    if (!token) return false;
    const id = hashToken(token);
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row) return false;
    if (row.expiresAt.getTime() <= Date.now()) {
      this.db.delete(sessions).where(eq(sessions.id, id)).run();
      return false;
    }
    return true;
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
