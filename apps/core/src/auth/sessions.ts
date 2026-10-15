import { createHash, randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Opaque random session tokens; only their SHA-256 is persisted. */
export class SessionStore {
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
    if (token) this.db.delete(sessions).where(eq(sessions.id, hashToken(token))).run();
  }

  /** Ends every session (after a password change or reset). */
  revokeAll(): void {
    this.db.delete(sessions).run();
  }

  purgeExpired(): void {
    this.db.delete(sessions).where(lt(sessions.expiresAt, new Date())).run();
  }
}
