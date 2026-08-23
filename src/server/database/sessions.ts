import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { AppDatabase } from './client.js';
import { sessions } from './schema.js';
import { hashToken } from './token-hash.js';

const SESSION_BYTES = 32;
const SESSION_TTL_DAYS = 30;
const MILLISECONDS_PER_DAY = 86_400_000;
/** Cookie Max-Age and the row's expires_at come from the same number, so they cannot drift apart. */
export const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 86_400;

export type SessionRecord = {
  id: string;
  clientId: string;
  userAgent: string | undefined;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
};

export function createSessionStore(database: AppDatabase) {
  return {
    /**
     * Mints a browser session and returns its plaintext token — the only moment
     * that value exists outside the caller's hands, since only its hash is stored.
     *
     * Sessions back the cookie and nothing else. Agents authenticate with OAuth
     * access tokens, which live in `oauth_access_tokens` and carry an audience and
     * a refresh chain that a session has no concept of.
     */
    async createSession(userId: string, clientId: string): Promise<{ token: string; expiresAt: Date }> {
      const token = randomBytes(SESSION_BYTES).toString('base64url');
      const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * MILLISECONDS_PER_DAY);
      await database.insert(sessions).values({ tokenHash: hashToken(token), userId, clientId, expiresAt });
      return { token, expiresAt };
    },

    /**
     * Resolves a session cookie to its live session.
     *
     * Side effect: stamps `last_used_at` and records the caller's user agent, so
     * that "Sessions" reflects what is actually talking to Bifrost. Expired
     * sessions match nothing and are therefore never revived by this call.
     */
    async resolveSessionAndTouch(token: string, userAgent?: string): Promise<{ sessionId: string; userId: string; clientId: string; expiresAt: Date } | undefined> {
      const [row] = await database
        .update(sessions)
        .set({
          lastUsedAt: sql`now()`,
          userAgent: sql`coalesce(${userAgent ?? null}, ${sessions.userAgent})`,
        })
        .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, sql`now()`)))
        .returning({ sessionId: sessions.id, userId: sessions.userId, clientId: sessions.clientId, expiresAt: sessions.expiresAt });
      return row;
    },

    async deleteSession(token: string): Promise<void> {
      await database.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    },

    /** Live sessions only: an expired session cannot be used, so listing it would just be noise. */
    async listSessions(userId: string): Promise<readonly SessionRecord[]> {
      const rows = await database
        .select({
          id: sessions.id,
          clientId: sessions.clientId,
          userAgent: sessions.userAgent,
          createdAt: sessions.createdAt,
          lastUsedAt: sessions.lastUsedAt,
          expiresAt: sessions.expiresAt,
        })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, sql`now()`)))
        .orderBy(desc(sessions.lastUsedAt));
      return rows.map((row) => ({ ...row, userAgent: row.userAgent ?? undefined }));
    },

    /** Scoped by `user_id` on purpose: a session id must never let one user revoke another's client. */
    async revokeSession(userId: string, sessionId: string): Promise<boolean> {
      const rows = await database
        .delete(sessions)
        .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)))
        .returning({ id: sessions.id });
      return rows.length > 0;
    },

    /**
     * Extends a session that is still alive. Already-expired sessions are
     * deliberately not renewable: resurrecting one would hand a possibly-leaked
     * token another 30 days, and the program can simply sign in again.
     */
    async renewSession(userId: string, sessionId: string): Promise<Date | undefined> {
      const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * MILLISECONDS_PER_DAY);
      const [row] = await database
        .update(sessions)
        .set({ expiresAt })
        .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId), gt(sessions.expiresAt, sql`now()`)))
        .returning({ expiresAt: sessions.expiresAt });
      return row?.expiresAt;
    },
  };
}
