import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from './config.js';
import { createDatabaseConnection, type AppDatabase, type AppTransaction } from './database/client.js';
import {
  deploymentToolPolicies,
  oauthAccessTokens,
  oauthClients,
  oauthGrants,
  oauthRefreshTokens,
  providerCredentials,
  sessions,
  userProviderPreferences,
  users,
  userToolPreferences,
} from './database/schema.js';
import type { ProviderId } from './providers/types.js';
import { decryptSecret, encryptSecret } from './security/secrets.js';
import type { StoredToolPolicy, ToolPolicyState } from './tools/catalog.js';

const SESSION_BYTES = 32;
const SESSION_TTL_DAYS = 30;
/** Cookie Max-Age and the row's expires_at come from the same number, so they cannot drift apart. */
export const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 86_400;
const OAUTH_TOKEN_BYTES = 32;
const MILLISECONDS_PER_DAY = 86_400_000;

export type StoredCredential = {
  accessToken: string;
  refreshToken?: string;
  oauthClientId?: string;
  expiresAt?: Date;
  scopes: readonly string[];
};

export type SessionRecord = {
  id: string;
  clientId: string;
  userAgent: string | undefined;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
};

export type StoredOAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: readonly string[];
  registrationKind: 'dynamic' | 'metadata-document';
  metadataExpiresAt: Date | undefined;
};

/** A grant as "Agents & sessions" needs it: no token material, only what a human can act on. */
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

type ToolPolicyWrite = {
  providerId: ProviderId;
  toolName: string;
  fingerprint: string;
  state: ToolPolicyState;
  updatedByUserId: string;
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

const credentialPayloadSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  oauthClientId: z.string().min(1).optional(),
});
type CredentialPayload = z.infer<typeof credentialPayloadSchema>;

type OAuthAccessTokenRow = {
  grantId: string;
  userId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  expiresAt: string;
};

type ReplayedGrantRow = { userId: string; clientId: string };

export class Database {
  private readonly client: ReturnType<typeof createDatabaseConnection>['client'];
  private readonly database: AppDatabase;

  constructor(private readonly config: Config) {
    const connection = createDatabaseConnection(config.DATABASE_URL);
    this.client = connection.client;
    this.database = connection.database;
  }

  async close(): Promise<void> {
    await this.client.end();
  }

  async upsertUser(email: string, name: string): Promise<string> {
    const [row] = await this.database
      .insert(users)
      .values({ id: randomUUID(), email, name })
      .onConflictDoUpdate({ target: users.email, set: { name } })
      .returning({ id: users.id });
    if (!row) throw new Error('User upsert returned no row');
    return row.id;
  }

  async getUser(userId: string): Promise<{ name: string; email: string } | undefined> {
    const [row] = await this.database
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row;
  }

  async ensureDevelopmentUser(userId: string): Promise<void> {
    await this.database
      .insert(users)
      .values({ id: userId, email: `${userId}@development.invalid`, name: 'Development User' })
      .onConflictDoNothing({ target: users.id });
  }

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
    await this.database.insert(sessions).values({ tokenHash: hashToken(token), userId, clientId, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Resolves a session cookie to its live session.
   *
   * Side effect: stamps `last_used_at` and records the caller's user agent, so
   * that "Agents & sessions" reflects what is actually talking to Bifrost. Expired
   * sessions match nothing and are therefore never revived by this call.
   */
  async resolveSessionAndTouch(token: string, userAgent?: string): Promise<{ sessionId: string; userId: string; clientId: string; expiresAt: Date } | undefined> {
    const [row] = await this.database
      .update(sessions)
      .set({
        lastUsedAt: sql`now()`,
        userAgent: sql`coalesce(${userAgent ?? null}, ${sessions.userAgent})`,
      })
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, sql`now()`)))
      .returning({ sessionId: sessions.id, userId: sessions.userId, clientId: sessions.clientId, expiresAt: sessions.expiresAt });
    return row;
  }

  async deleteSession(token: string): Promise<void> {
    await this.database.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }

  /** Live sessions only: an expired session cannot be used, so listing it would just be noise. */
  async listSessions(userId: string): Promise<readonly SessionRecord[]> {
    const rows = await this.database
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
  }

  /** Scoped by `user_id` on purpose: a session id must never let one user revoke another's client. */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const rows = await this.database
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)))
      .returning({ id: sessions.id });
    return rows.length > 0;
  }

  /**
   * Extends a session that is still alive. Already-expired sessions are
   * deliberately not renewable: resurrecting one would hand a possibly-leaked
   * token another 30 days, and the program can simply sign in again.
   */
  async renewSession(userId: string, sessionId: string): Promise<Date | undefined> {
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * MILLISECONDS_PER_DAY);
    const [row] = await this.database
      .update(sessions)
      .set({ expiresAt })
      .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId), gt(sessions.expiresAt, sql`now()`)))
      .returning({ expiresAt: sessions.expiresAt });
    return row?.expiresAt;
  }

  async upsertOAuthClient(client: StoredOAuthClient): Promise<void> {
    await this.database
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
  }

  async getOAuthClient(clientId: string): Promise<StoredOAuthClient | undefined> {
    const [row] = await this.database
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
  }

  /** Whether this client was already approved, which is what lets consent be skipped on reconnect. */
  async hasOAuthGrant(userId: string, clientId: string, resource: string): Promise<boolean> {
    const rows = await this.database
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.userId, userId), eq(oauthGrants.clientId, clientId), eq(oauthGrants.resource, resource)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Records the user's approval and issues the first token pair.
   *
   * Re-approving an existing client updates that grant rather than adding
   * another, so reconnecting a client does not accumulate rows the user then has
   * to tell apart in "Agents & sessions".
   *
   * No user agent is recorded here on purpose: at this point the caller is the
   * browser the human approved in, not the program being authorized. The agent's
   * own user agent arrives with its first MCP call and is stamped then.
   */
  async authorizeOAuthGrant(input: {
    userId: string; clientId: string; scopes: readonly string[]; resource: string;
  }): Promise<OAuthTokenPair> {
    return this.database.transaction(async (transaction) => {
      const [grant] = await transaction
        .insert(oauthGrants)
        .values({ userId: input.userId, clientId: input.clientId, scopes: [...input.scopes], resource: input.resource })
        .onConflictDoUpdate({
          target: [oauthGrants.userId, oauthGrants.clientId, oauthGrants.resource],
          set: { scopes: [...input.scopes], lastUsedAt: sql`now()` },
        })
        .returning({ id: oauthGrants.id });
      if (!grant) throw new Error('Grant upsert returned no row');
      return this.issueTokenPair(transaction, grant.id);
    });
  }

  /**
   * Spends a refresh token and issues a replacement pair.
   *
   * The `consumed_at IS NULL` guard in the UPDATE is what makes this single-use:
   * two concurrent refreshes race on one row and exactly one wins, so a client
   * retrying a timed-out request cannot end up with two live chains.
   */
  async rotateOAuthRefreshToken(refreshToken: string, clientId: string): Promise<RefreshOutcome> {
    const tokenHash = hashToken(refreshToken);
    return this.database.transaction(async (transaction) => {
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
        return { kind: 'rotated' as const, tokens: await this.issueTokenPair(transaction, consumed.grantId) };
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
  }

  /**
   * Resolves a bearer access token to the grant behind it.
   *
   * Stamps `last_used_at` in the same statement, so "Agents & sessions" stays honest
   * without a second round trip on every MCP call. Expired tokens match nothing.
   */
  async resolveOAuthAccessTokenAndTouch(token: string, userAgent?: string): Promise<OAuthIdentity | undefined> {
    const result = await this.database.execute<OAuthAccessTokenRow>(sql`
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
  }

  async listOAuthGrants(userId: string): Promise<readonly OAuthGrantRecord[]> {
    const rows = await this.database
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
  }

  /** Scoped by `user_id` so a grant id can never let one user disconnect another's client. */
  async revokeOAuthGrant(userId: string, grantId: string): Promise<boolean> {
    const rows = await this.database
      .delete(oauthGrants)
      .where(and(eq(oauthGrants.userId, userId), eq(oauthGrants.id, grantId)))
      .returning({ id: oauthGrants.id });
    return rows.length > 0;
  }

  /**
   * RFC 7009 revocation. A refresh token takes its whole grant with it because
   * it represents the authorization itself; an access token is just one lease,
   * so revoking it leaves the client able to refresh.
   */
  async revokeOAuthToken(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    const refreshTokenGrants = this.database
      .select({ grantId: oauthRefreshTokens.grantId })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, tokenHash));
    const revokedGrants = await this.database
      .delete(oauthGrants)
      .where(inArray(oauthGrants.id, refreshTokenGrants))
      .returning({ id: oauthGrants.id });
    if (revokedGrants.length === 0) {
      await this.database.delete(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, tokenHash));
    }
  }

  /**
   * Clears tokens that can no longer authenticate anything. Expiry is enforced
   * by every read path, so this is housekeeping rather than a security control.
   */
  async deleteExpiredOAuthTokens(): Promise<void> {
    await this.database.delete(oauthAccessTokens).where(lte(oauthAccessTokens.expiresAt, sql`now()`));
    await this.database.delete(oauthRefreshTokens).where(lte(oauthRefreshTokens.expiresAt, sql`now()`));
  }

  private async issueTokenPair(transaction: AppTransaction, grantId: string): Promise<OAuthTokenPair> {
    const accessToken = randomBytes(OAUTH_TOKEN_BYTES).toString('base64url');
    const refreshToken = randomBytes(OAUTH_TOKEN_BYTES).toString('base64url');
    const accessTokenExpiresAt = new Date(Date.now() + this.config.OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
    // Slid forward on every rotation, so a client that keeps talking never has
    // to be reconnected by hand and one that goes quiet eventually lapses.
    const refreshTokenExpiresAt = new Date(Date.now() + this.config.OAUTH_REFRESH_TOKEN_TTL_DAYS * MILLISECONDS_PER_DAY);
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

  async saveCredential(userId: string, providerId: ProviderId, credential: StoredCredential): Promise<void> {
    const payload: CredentialPayload = { accessToken: credential.accessToken };
    if (credential.refreshToken !== undefined) payload.refreshToken = credential.refreshToken;
    if (credential.oauthClientId !== undefined) payload.oauthClientId = credential.oauthClientId;
    const encryptedPayload = encryptSecret(JSON.stringify(payload), this.config.encryptionKey);
    await this.database
      .insert(providerCredentials)
      .values({
        userId,
        providerId,
        encryptedPayload,
        expiresAt: credential.expiresAt ?? null,
        scopes: [...credential.scopes],
      })
      .onConflictDoUpdate({
        target: [providerCredentials.userId, providerCredentials.providerId],
        set: {
          encryptedPayload,
          expiresAt: credential.expiresAt ?? null,
          scopes: [...credential.scopes],
          updatedAt: sql`now()`,
        },
      });
  }

  async getCredential(userId: string, providerId: ProviderId): Promise<StoredCredential | undefined> {
    const [row] = await this.database
      .select({
        encryptedPayload: providerCredentials.encryptedPayload,
        expiresAt: providerCredentials.expiresAt,
        scopes: providerCredentials.scopes,
      })
      .from(providerCredentials)
      .where(and(eq(providerCredentials.userId, userId), eq(providerCredentials.providerId, providerId)))
      .limit(1);
    if (!row) return undefined;
    // Parsed, not asserted: a row that decrypts to something else must fail
    // here rather than hand a non-string token to an outbound request.
    const payload = credentialPayloadSchema.parse(JSON.parse(decryptSecret(row.encryptedPayload, this.config.encryptionKey)));
    return {
      accessToken: payload.accessToken,
      ...(payload.refreshToken === undefined ? {} : { refreshToken: payload.refreshToken }),
      ...(payload.oauthClientId === undefined ? {} : { oauthClientId: payload.oauthClientId }),
      ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
      scopes: row.scopes,
    };
  }

  async deleteCredential(userId: string, providerId: ProviderId): Promise<void> {
    await this.database
      .delete(providerCredentials)
      .where(and(eq(providerCredentials.userId, userId), eq(providerCredentials.providerId, providerId)));
  }

  async connectedProviders(userId: string): Promise<Set<ProviderId>> {
    const rows = await this.database
      .select({ providerId: providerCredentials.providerId })
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, userId));
    return new Set(rows.map((row) => row.providerId));
  }

  /**
   * Everything Integrations needs to describe a live connection: when it was
   * made, who it was made as, and whether the token has already lapsed.
   * `needsReconnect` is derived here rather than in the UI so the rule lives
   * next to the column that decides it.
   */
  async listConnections(userId: string): Promise<readonly { providerId: ProviderId; connectedAt: Date; accountLabel: string | undefined; needsReconnect: boolean; scopes: readonly string[] }[]> {
    const rows = await this.database
      .select({
        providerId: providerCredentials.providerId,
        connectedAt: providerCredentials.createdAt,
        accountLabel: providerCredentials.accountLabel,
        needsReconnect: sql<boolean>`${providerCredentials.expiresAt} is not null and ${providerCredentials.expiresAt} <= now()`,
        scopes: providerCredentials.scopes,
      })
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, userId));
    return rows.map((row) => ({ ...row, accountLabel: row.accountLabel ?? undefined }));
  }

  /** Best-effort display name. A connection stays perfectly usable without one. */
  async setAccountLabel(userId: string, providerId: ProviderId, accountLabel: string): Promise<void> {
    await this.database
      .update(providerCredentials)
      .set({ accountLabel })
      .where(and(eq(providerCredentials.userId, userId), eq(providerCredentials.providerId, providerId)));
  }

  async hiddenProviders(userId: string): Promise<Set<ProviderId>> {
    const rows = await this.database
      .select({ providerId: userProviderPreferences.providerId })
      .from(userProviderPreferences)
      .where(and(eq(userProviderPreferences.userId, userId), eq(userProviderPreferences.isHidden, true)));
    return new Set(rows.map((row) => row.providerId));
  }

  async setProviderHidden(userId: string, providerId: ProviderId, isHidden: boolean): Promise<void> {
    await this.database
      .insert(userProviderPreferences)
      .values({ userId, providerId, isHidden })
      .onConflictDoUpdate({
        target: [userProviderPreferences.userId, userProviderPreferences.providerId],
        set: { isHidden },
      });
  }

  /**
   * The tools this user has overridden. Absence means the administrator's
   * current default applies.
   */
  async toolPreferences(userId: string): Promise<ReadonlyMap<string, boolean>> {
    const rows = await this.database
      .select({ toolName: userToolPreferences.toolName, isEnabled: userToolPreferences.isEnabled })
      .from(userToolPreferences)
      .where(eq(userToolPreferences.userId, userId));
    return new Map(rows.map((row) => [row.toolName, row.isEnabled]));
  }

  async setToolPreference(userId: string, toolName: string, isEnabled: boolean): Promise<void> {
    await this.database
      .insert(userToolPreferences)
      .values({ userId, toolName, isEnabled })
      .onConflictDoUpdate({
        target: [userToolPreferences.userId, userToolPreferences.toolName],
        set: { isEnabled },
      });
  }

  async clearToolPreference(userId: string, toolName: string): Promise<void> {
    await this.database
      .delete(userToolPreferences)
      .where(and(eq(userToolPreferences.userId, userId), eq(userToolPreferences.toolName, toolName)));
  }

  async toolPolicies(): Promise<ReadonlyMap<string, StoredToolPolicy>> {
    const rows = await this.database
      .select({
        toolName: deploymentToolPolicies.toolName,
        fingerprint: deploymentToolPolicies.fingerprint,
        state: deploymentToolPolicies.state,
      })
      .from(deploymentToolPolicies);
    return new Map(rows.map((row) => [row.toolName, row]));
  }

  async setToolPolicies(requests: readonly ToolPolicyWrite[]): Promise<void> {
    await this.database.transaction(async (transaction) => {
      for (const request of requests) {
        await transaction
          .insert(deploymentToolPolicies)
          .values(request)
          .onConflictDoUpdate({
            target: [deploymentToolPolicies.providerId, deploymentToolPolicies.toolName],
            set: {
              fingerprint: request.fingerprint,
              state: request.state,
              updatedByUserId: request.updatedByUserId,
              updatedAt: new Date(),
            },
          });
      }
    });
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
