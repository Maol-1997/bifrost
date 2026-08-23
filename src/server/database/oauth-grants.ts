import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { AppDatabase, AppTransaction } from './client.js';
import { oauthAccessTokens, oauthClients, oauthGrants, oauthRefreshTokens } from './schema.js';
import { hashToken } from './token-hash.js';

const OAUTH_TOKEN_BYTES = 32;
const MILLISECONDS_PER_DAY = 86_400_000;

export type StoredOAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: readonly string[];
  registrationKind: 'dynamic' | 'metadata-document';
  metadataExpiresAt: Date | undefined;
};

/** Fields needed to display and revoke a grant without exposing token material. */
export type OAuthGrantRecord = {
  id: string;
  clientId: string;
  clientName: string;
  userAgent: string | undefined;
  createdAt: Date;
  lastUsedAt: Date;
};

export type OAuthTokenPair = { accessToken: string; refreshToken: string; accessTokenExpiresAt: Date };

export type OAuthIdentity = {
  grantId: string;
  userId: string;
  clientId: string;
  resource: string;
  scopes: readonly string[];
  expiresAt: Date;
};

/**
 * Why a refresh attempt ended the way it did.
 *
 * `replayed` is deliberately distinct from `unknown`. Both fail the request, but
 * a spent token coming back means the value leaked, which is a security event
 * worth recording and a reason to destroy the grant rather than just decline.
 */
export type RefreshOutcome =
  | { kind: 'rotated'; tokens: OAuthTokenPair }
  | { kind: 'unknown' }
  | { kind: 'replayed'; userId: string; clientId: string };

type OAuthAccessTokenRow = {
  grantId: string;
  userId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  expiresAt: string;
};

type ReplayedGrantRow = { userId: string; clientId: string };

export function createOAuthGrantStore(database: AppDatabase, config: Config) {
  async function issueTokenPair(transaction: AppTransaction, grantId: string): Promise<OAuthTokenPair> {
    const accessToken = randomBytes(OAUTH_TOKEN_BYTES).toString('base64url');
    const refreshToken = randomBytes(OAUTH_TOKEN_BYTES).toString('base64url');
    const accessTokenExpiresAt = new Date(Date.now() + config.OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
    // Slid forward on every rotation, so a client that keeps talking never has
    // to be reconnected by hand and one that goes quiet eventually lapses.
    const refreshTokenExpiresAt = new Date(Date.now() + config.OAUTH_REFRESH_TOKEN_TTL_DAYS * MILLISECONDS_PER_DAY);
    await transaction.insert(oauthAccessTokens).values({
      tokenHash: hashToken(accessToken),
      grantId,
      expiresAt: accessTokenExpiresAt,
    });
    await transaction.insert(oauthRefreshTokens).values({
      tokenHash: hashToken(refreshToken),
      grantId,
      expiresAt: refreshTokenExpiresAt,
    });
    return { accessToken, refreshToken, accessTokenExpiresAt };
  }

  return {
    async upsertOAuthClient(client: StoredOAuthClient): Promise<void> {
      await database
        .insert(oauthClients)
        .values({
          clientId: client.clientId,
          clientName: client.clientName,
          redirectUris: [...client.redirectUris],
          registrationKind: client.registrationKind,
          metadataExpiresAt: client.metadataExpiresAt ?? null,
        })
        .onConflictDoUpdate({
          target: oauthClients.clientId,
          set: {
            clientName: client.clientName,
            redirectUris: [...client.redirectUris],
            metadataExpiresAt: client.metadataExpiresAt ?? null,
          },
        });
    },

    async getOAuthClient(clientId: string): Promise<StoredOAuthClient | undefined> {
      const [row] = await database
        .select({
          clientId: oauthClients.clientId,
          clientName: oauthClients.clientName,
          redirectUris: oauthClients.redirectUris,
          registrationKind: oauthClients.registrationKind,
          metadataExpiresAt: oauthClients.metadataExpiresAt,
        })
        .from(oauthClients)
        .where(eq(oauthClients.clientId, clientId))
        .limit(1);
      if (!row) return undefined;
      return { ...row, metadataExpiresAt: row.metadataExpiresAt ?? undefined };
    },

    /** Whether this client was already approved, which is what lets consent be skipped on reconnect. */
    async hasOAuthGrant(userId: string, clientId: string, resource: string): Promise<boolean> {
      const rows = await database
        .select({ id: oauthGrants.id })
        .from(oauthGrants)
        .where(and(eq(oauthGrants.userId, userId), eq(oauthGrants.clientId, clientId), eq(oauthGrants.resource, resource)))
        .limit(1);
      return rows.length > 0;
    },

    /**
     * Records the user's approval and issues the first token pair.
     *
     * Re-approving an existing client updates that grant rather than adding
     * another, so reconnecting a client does not accumulate rows the user then has
     * to tell apart in "Sessions".
     *
     * No user agent is recorded here on purpose: at this point the caller is the
     * browser the human approved in, not the program being authorized. The agent's
     * own user agent arrives with its first MCP call and is stamped then.
     */
    async authorizeOAuthGrant(input: {
      userId: string; clientId: string; scopes: readonly string[]; resource: string;
    }): Promise<OAuthTokenPair> {
      return database.transaction(async (transaction) => {
        const [grant] = await transaction
          .insert(oauthGrants)
          .values({ userId: input.userId, clientId: input.clientId, scopes: [...input.scopes], resource: input.resource })
          .onConflictDoUpdate({
            target: [oauthGrants.userId, oauthGrants.clientId, oauthGrants.resource],
            set: { scopes: [...input.scopes], lastUsedAt: sql`now()` },
          })
          .returning({ id: oauthGrants.id });
        if (!grant) throw new Error('Grant upsert returned no row');
        return issueTokenPair(transaction, grant.id);
      });
    },

    /**
     * Spends a refresh token and issues a replacement pair.
     *
     * The `consumed_at IS NULL` guard in the UPDATE is what makes this single-use:
     * two concurrent refreshes race on one row and exactly one wins, so a client
     * retrying a timed-out request cannot end up with two live chains.
     */
    async rotateOAuthRefreshToken(refreshToken: string, clientId: string): Promise<RefreshOutcome> {
      const tokenHash = hashToken(refreshToken);
      return database.transaction(async (transaction) => {
        const grantsForClient = transaction
          .select({ id: oauthGrants.id })
          .from(oauthGrants)
          .where(eq(oauthGrants.clientId, clientId));
        const [consumed] = await transaction
          .update(oauthRefreshTokens)
          .set({ consumedAt: sql`now()` })
          .where(and(
            eq(oauthRefreshTokens.tokenHash, tokenHash),
            isNull(oauthRefreshTokens.consumedAt),
            gt(oauthRefreshTokens.expiresAt, sql`now()`),
            inArray(oauthRefreshTokens.grantId, grantsForClient),
          ))
          .returning({ grantId: oauthRefreshTokens.grantId });
        if (consumed) {
          await transaction.update(oauthGrants).set({ lastUsedAt: sql`now()` }).where(eq(oauthGrants.id, consumed.grantId));
          return { kind: 'rotated' as const, tokens: await issueTokenPair(transaction, consumed.grantId) };
        }

        const replayed = await transaction.execute<ReplayedGrantRow>(sql`
          delete from ${oauthGrants}
          where ${oauthGrants.id} = (
            select ${oauthRefreshTokens.grantId}
            from ${oauthRefreshTokens}
            where ${oauthRefreshTokens.tokenHash} = ${tokenHash}
              and ${oauthRefreshTokens.consumedAt} is not null
          )
          returning ${oauthGrants.userId} as "userId", ${oauthGrants.clientId} as "clientId"
        `);
        const [row] = replayed.rows;
        if (!row) return { kind: 'unknown' as const };
        return { kind: 'replayed' as const, userId: row.userId, clientId: row.clientId };
      });
    },

    /**
     * Resolves a bearer access token to the grant behind it.
     *
     * Stamps `last_used_at` in the same statement, so "Sessions" stays honest
     * without a second round trip on every MCP call. Expired tokens match nothing.
     */
    async resolveOAuthAccessTokenAndTouch(token: string, userAgent?: string): Promise<OAuthIdentity | undefined> {
      const result = await database.execute<OAuthAccessTokenRow>(sql`
        update ${oauthGrants}
        set "last_used_at" = now(),
          "user_agent" = coalesce(${userAgent ?? null}, ${oauthGrants.userAgent})
        from ${oauthAccessTokens}
        where ${oauthAccessTokens.tokenHash} = ${hashToken(token)}
          and ${oauthAccessTokens.expiresAt} > now()
          and ${oauthGrants.id} = ${oauthAccessTokens.grantId}
        returning ${oauthGrants.id} as "grantId", ${oauthGrants.userId} as "userId",
          ${oauthGrants.clientId} as "clientId", ${oauthGrants.resource} as "resource",
          ${oauthGrants.scopes} as "scopes", ${oauthAccessTokens.expiresAt} as "expiresAt"
      `);
      const [row] = result.rows;
      if (!row) return undefined;
      return { ...row, expiresAt: new Date(row.expiresAt) };
    },

    async listOAuthGrants(userId: string): Promise<readonly OAuthGrantRecord[]> {
      const rows = await database
        .select({
          id: oauthGrants.id,
          clientId: oauthGrants.clientId,
          clientName: oauthClients.clientName,
          userAgent: oauthGrants.userAgent,
          createdAt: oauthGrants.createdAt,
          lastUsedAt: oauthGrants.lastUsedAt,
        })
        .from(oauthGrants)
        .innerJoin(oauthClients, eq(oauthClients.clientId, oauthGrants.clientId))
        .where(eq(oauthGrants.userId, userId))
        .orderBy(desc(oauthGrants.lastUsedAt));
      return rows.map((row) => ({ ...row, userAgent: row.userAgent ?? undefined }));
    },

    /** Scoped by `user_id` so a grant id can never let one user disconnect another's client. */
    async revokeOAuthGrant(userId: string, grantId: string): Promise<boolean> {
      const rows = await database
        .delete(oauthGrants)
        .where(and(eq(oauthGrants.userId, userId), eq(oauthGrants.id, grantId)))
        .returning({ id: oauthGrants.id });
      return rows.length > 0;
    },

    /**
     * RFC 7009 revocation. A refresh token takes its whole grant with it because
     * it represents the authorization itself; an access token is just one lease,
     * so revoking it leaves the client able to refresh.
     */
    async revokeOAuthToken(token: string): Promise<void> {
      const tokenHash = hashToken(token);
      const refreshTokenGrants = database
        .select({ grantId: oauthRefreshTokens.grantId })
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.tokenHash, tokenHash));
      const revokedGrants = await database
        .delete(oauthGrants)
        .where(inArray(oauthGrants.id, refreshTokenGrants))
        .returning({ id: oauthGrants.id });
      if (revokedGrants.length === 0) {
        await database.delete(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, tokenHash));
      }
    },

    /**
     * Clears tokens that can no longer authenticate anything. Expiry is enforced
     * by every read path, so this is housekeeping rather than a security control.
     *
     * Consumed refresh tokens stay until they expire on purpose: they are what
     * turns a replayed token into a detected leak instead of an unknown token.
     */
    async deleteExpiredOAuthTokens(): Promise<{ accessTokens: number; refreshTokens: number }> {
      const accessTokens = await database.delete(oauthAccessTokens).where(lte(oauthAccessTokens.expiresAt, sql`now()`));
      const refreshTokens = await database.delete(oauthRefreshTokens).where(lte(oauthRefreshTokens.expiresAt, sql`now()`));
      return { accessTokens: accessTokens.rowCount ?? 0, refreshTokens: refreshTokens.rowCount ?? 0 };
    },
  };
}
