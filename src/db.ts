import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Config } from './config.js';
import { decryptSecret, encryptSecret, type EncryptedSecret } from './security/secrets.js';
import type { ProviderId } from './providers/types.js';

const { Pool } = pg;
const SESSION_BYTES = 32;
const SESSION_TTL_DAYS = 30;
const OAUTH_TOKEN_BYTES = 32;
const MILLISECONDS_PER_DAY = 86_400_000;

export type StoredCredential = {
  accessToken: string;
  refreshToken?: string;
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

type CredentialPayload = { accessToken: string; refreshToken?: string };

export class Database {
  readonly pool: pg.Pool;

  constructor(private readonly config: Config) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertUser(email: string, name: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [randomUUID(), email, name],
    );
    const row = result.rows[0];
    if (!row) throw new Error('User upsert returned no row');
    return row.id;
  }

  async getUser(userId: string): Promise<{ name: string; email: string } | undefined> {
    const result = await this.pool.query<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = $1', [userId]);
    return result.rows[0];
  }

  async ensureDevelopmentUser(userId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@development.invalid`, 'Development User'],
    );
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
    await this.pool.query(
      'INSERT INTO sessions (token_hash, user_id, client_id, expires_at) VALUES ($1, $2, $3, $4)',
      [hashToken(token), userId, clientId, expiresAt],
    );
    return { token, expiresAt };
  }

  /**
   * Resolves a session cookie to its live session.
   *
   * Side effect: stamps `last_used_at` and records the caller's user agent, so
   * that "Agents & sessions" reflects what is actually talking to Bifrost. Expired
   * sessions match nothing and are therefore never revived by this call.
   */
  async resolveSession(token: string, userAgent?: string): Promise<{ sessionId: string; userId: string; clientId: string; expiresAt: Date } | undefined> {
    const result = await this.pool.query<{ id: string; user_id: string; client_id: string; expires_at: Date }>(
      `UPDATE sessions SET last_used_at = now(), user_agent = COALESCE($2, user_agent)
       WHERE token_hash = $1 AND expires_at > now()
       RETURNING id, user_id, client_id, expires_at`,
      [hashToken(token), userAgent ?? null],
    );
    const row = result.rows[0];
    return row ? { sessionId: row.id, userId: row.user_id, clientId: row.client_id, expiresAt: row.expires_at } : undefined;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  }

  /** Live sessions only: an expired session cannot be used, so listing it would just be noise. */
  async listSessions(userId: string): Promise<readonly SessionRecord[]> {
    const result = await this.pool.query<{
      id: string; client_id: string; user_agent: string | null; created_at: Date; last_used_at: Date; expires_at: Date;
    }>(
      `SELECT id, client_id, user_agent, created_at, last_used_at, expires_at FROM sessions
       WHERE user_id = $1 AND expires_at > now() ORDER BY last_used_at DESC`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      userAgent: row.user_agent ?? undefined,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
    }));
  }

  /** Scoped by `user_id` on purpose: a session id must never let one user revoke another's client. */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM sessions WHERE user_id = $1 AND id = $2', [userId, sessionId]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Extends a session that is still alive. Already-expired sessions are
   * deliberately not renewable: resurrecting one would hand a possibly-leaked
   * token another 30 days, and the program can simply sign in again.
   */
  async renewSession(userId: string, sessionId: string): Promise<Date | undefined> {
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * MILLISECONDS_PER_DAY);
    const result = await this.pool.query<{ expires_at: Date }>(
      `UPDATE sessions SET expires_at = $3 WHERE user_id = $1 AND id = $2 AND expires_at > now() RETURNING expires_at`,
      [userId, sessionId, expiresAt],
    );
    return result.rows[0]?.expires_at;
  }

  async upsertOAuthClient(client: StoredOAuthClient): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, registration_kind, metadata_expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name,
         redirect_uris = EXCLUDED.redirect_uris, metadata_expires_at = EXCLUDED.metadata_expires_at`,
      [client.clientId, client.clientName, client.redirectUris, client.registrationKind, client.metadataExpiresAt ?? null],
    );
  }

  async getOAuthClient(clientId: string): Promise<StoredOAuthClient | undefined> {
    const result = await this.pool.query<{
      client_id: string; client_name: string; redirect_uris: string[];
      registration_kind: 'dynamic' | 'metadata-document'; metadata_expires_at: Date | null;
    }>('SELECT client_id, client_name, redirect_uris, registration_kind, metadata_expires_at FROM oauth_clients WHERE client_id = $1', [clientId]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      clientId: row.client_id,
      clientName: row.client_name,
      redirectUris: row.redirect_uris,
      registrationKind: row.registration_kind,
      metadataExpiresAt: row.metadata_expires_at ?? undefined,
    };
  }

  /** Whether this client was already approved, which is what lets consent be skipped on reconnect. */
  async hasOAuthGrant(userId: string, clientId: string, resource: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM oauth_grants WHERE user_id = $1 AND client_id = $2 AND resource = $3',
      [userId, clientId, resource],
    );
    return result.rows.length > 0;
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
    return this.withTransaction(async (client) => {
      const grant = await client.query<{ id: string }>(
        `INSERT INTO oauth_grants (user_id, client_id, scopes, resource) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, client_id, resource) DO UPDATE SET scopes = EXCLUDED.scopes, last_used_at = now()
         RETURNING id`,
        [input.userId, input.clientId, input.scopes, input.resource],
      );
      const grantId = grant.rows[0]?.id;
      if (!grantId) throw new Error('Grant upsert returned no row');
      return this.issueTokenPair(client, grantId);
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
    return this.withTransaction(async (client) => {
      const consumed = await client.query<{ grant_id: string }>(
        `UPDATE oauth_refresh_tokens SET consumed_at = now()
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
         AND grant_id IN (SELECT id FROM oauth_grants WHERE client_id = $2)
         RETURNING grant_id`,
        [tokenHash, clientId],
      );
      const grantId = consumed.rows[0]?.grant_id;
      if (grantId) {
        await client.query('UPDATE oauth_grants SET last_used_at = now() WHERE id = $1', [grantId]);
        return { kind: 'rotated' as const, tokens: await this.issueTokenPair(client, grantId) };
      }
      // Nothing was consumed. If the token exists anyway it was already spent,
      // which means someone is replaying a value that should have been discarded
      // — so the whole grant goes, not just this token.
      const replayed = await client.query<{ user_id: string; client_id: string }>(
        `DELETE FROM oauth_grants WHERE id = (
           SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash = $1 AND consumed_at IS NOT NULL
         ) RETURNING user_id, client_id`,
        [tokenHash],
      );
      const row = replayed.rows[0];
      if (!row) return { kind: 'unknown' as const };
      return { kind: 'replayed' as const, userId: row.user_id, clientId: row.client_id };
    });
  }

  /**
   * Resolves a bearer access token to the grant behind it.
   *
   * Stamps `last_used_at` in the same statement, so "Agents & sessions" stays honest
   * without a second round trip on every MCP call. Expired tokens match nothing.
   */
  async resolveOAuthAccessToken(token: string, userAgent?: string): Promise<OAuthIdentity | undefined> {
    const result = await this.pool.query<{
      id: string; user_id: string; client_id: string; resource: string; scopes: string[]; expires_at: Date;
    }>(
      `UPDATE oauth_grants SET last_used_at = now(), user_agent = COALESCE($2, oauth_grants.user_agent)
       FROM oauth_access_tokens
       WHERE oauth_access_tokens.token_hash = $1 AND oauth_access_tokens.expires_at > now()
         AND oauth_grants.id = oauth_access_tokens.grant_id
       RETURNING oauth_grants.id, oauth_grants.user_id, oauth_grants.client_id, oauth_grants.resource,
         oauth_grants.scopes, oauth_access_tokens.expires_at`,
      [hashToken(token), userAgent ?? null],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      grantId: row.id, userId: row.user_id, clientId: row.client_id,
      resource: row.resource, scopes: row.scopes, expiresAt: row.expires_at,
    };
  }

  async listOAuthGrants(userId: string): Promise<readonly OAuthGrantRecord[]> {
    const result = await this.pool.query<{
      id: string; client_id: string; client_name: string; user_agent: string | null; created_at: Date; last_used_at: Date;
    }>(
      `SELECT oauth_grants.id, oauth_grants.client_id, oauth_clients.client_name, oauth_grants.user_agent,
         oauth_grants.created_at, oauth_grants.last_used_at
       FROM oauth_grants JOIN oauth_clients ON oauth_clients.client_id = oauth_grants.client_id
       WHERE oauth_grants.user_id = $1 ORDER BY oauth_grants.last_used_at DESC`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      clientName: row.client_name,
      userAgent: row.user_agent ?? undefined,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  /** Scoped by `user_id` so a grant id can never let one user disconnect another's client. */
  async revokeOAuthGrant(userId: string, grantId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM oauth_grants WHERE user_id = $1 AND id = $2', [userId, grantId]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * RFC 7009 revocation. A refresh token takes its whole grant with it because
   * it represents the authorization itself; an access token is just one lease,
   * so revoking it leaves the client able to refresh.
   */
  async revokeOAuthToken(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    const result = await this.pool.query(
      'DELETE FROM oauth_grants WHERE id IN (SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash = $1)',
      [tokenHash],
    );
    if ((result.rowCount ?? 0) === 0) await this.pool.query('DELETE FROM oauth_access_tokens WHERE token_hash = $1', [tokenHash]);
  }

  /**
   * Clears tokens that can no longer authenticate anything. Expiry is enforced
   * by every read path, so this is housekeeping rather than a security control.
   */
  async deleteExpiredOAuthTokens(): Promise<void> {
    await this.pool.query('DELETE FROM oauth_access_tokens WHERE expires_at <= now()');
    await this.pool.query('DELETE FROM oauth_refresh_tokens WHERE expires_at <= now()');
  }

  private async issueTokenPair(client: pg.PoolClient, grantId: string): Promise<OAuthTokenPair> {
    const accessToken = randomBytes(OAUTH_TOKEN_BYTES).toString('base64url');
    const refreshToken = randomBytes(OAUTH_TOKEN_BYTES).toString('base64url');
    const accessTokenExpiresAt = new Date(Date.now() + this.config.OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
    // Slid forward on every rotation, so a client that keeps talking never has
    // to be reconnected by hand and one that goes quiet eventually lapses.
    const refreshTokenExpiresAt = new Date(Date.now() + this.config.OAUTH_REFRESH_TOKEN_TTL_DAYS * MILLISECONDS_PER_DAY);
    await client.query('INSERT INTO oauth_access_tokens (token_hash, grant_id, expires_at) VALUES ($1, $2, $3)', [hashToken(accessToken), grantId, accessTokenExpiresAt]);
    await client.query('INSERT INTO oauth_refresh_tokens (token_hash, grant_id, expires_at) VALUES ($1, $2, $3)', [hashToken(refreshToken), grantId, refreshTokenExpiresAt]);
    return { accessToken, refreshToken, accessTokenExpiresAt };
  }

  private async withTransaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveCredential(userId: string, providerId: ProviderId, credential: StoredCredential): Promise<void> {
    const payload: CredentialPayload = { accessToken: credential.accessToken };
    if (credential.refreshToken !== undefined) payload.refreshToken = credential.refreshToken;
    const encrypted = encryptSecret(JSON.stringify(payload), this.config.encryptionKey);
    await this.pool.query(
      `INSERT INTO provider_credentials (user_id, provider_id, encrypted_payload, expires_at, scopes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, provider_id) DO UPDATE SET encrypted_payload = EXCLUDED.encrypted_payload,
         expires_at = EXCLUDED.expires_at, scopes = EXCLUDED.scopes, updated_at = now()`,
      [userId, providerId, encrypted, credential.expiresAt ?? null, credential.scopes],
    );
  }

  async getCredential(userId: string, providerId: ProviderId): Promise<StoredCredential | undefined> {
    const result = await this.pool.query<{
      encrypted_payload: EncryptedSecret;
      expires_at: Date | null;
      scopes: string[];
    }>('SELECT encrypted_payload, expires_at, scopes FROM provider_credentials WHERE user_id = $1 AND provider_id = $2', [userId, providerId]);
    const row = result.rows[0];
    if (!row) return undefined;
    const payload = JSON.parse(decryptSecret(row.encrypted_payload, this.config.encryptionKey)) as CredentialPayload;
    return {
      accessToken: payload.accessToken,
      ...(payload.refreshToken === undefined ? {} : { refreshToken: payload.refreshToken }),
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      scopes: row.scopes,
    };
  }

  async deleteCredential(userId: string, providerId: ProviderId): Promise<void> {
    await this.pool.query('DELETE FROM provider_credentials WHERE user_id = $1 AND provider_id = $2', [userId, providerId]);
  }

  async connectedProviders(userId: string): Promise<Set<ProviderId>> {
    const result = await this.pool.query<{ provider_id: ProviderId }>('SELECT provider_id FROM provider_credentials WHERE user_id = $1', [userId]);
    return new Set(result.rows.map((row) => row.provider_id));
  }

  /**
   * Everything Integrations needs to describe a live connection: when it was
   * made, who it was made as, and whether the token has already lapsed.
   * `needsReconnect` is derived here rather than in the UI so the rule lives
   * next to the column that decides it.
   */
  async listConnections(userId: string): Promise<readonly { providerId: ProviderId; connectedAt: Date; accountLabel: string | undefined; needsReconnect: boolean }[]> {
    const result = await this.pool.query<{ provider_id: ProviderId; created_at: Date; account_label: string | null; needs_reconnect: boolean }>(
      `SELECT provider_id, created_at, account_label, (expires_at IS NOT NULL AND expires_at <= now()) AS needs_reconnect
       FROM provider_credentials WHERE user_id = $1`,
      [userId],
    );
    return result.rows.map((row) => ({
      providerId: row.provider_id,
      connectedAt: row.created_at,
      accountLabel: row.account_label ?? undefined,
      needsReconnect: row.needs_reconnect,
    }));
  }

  /** Best-effort display name. A connection stays perfectly usable without one. */
  async setAccountLabel(userId: string, providerId: ProviderId, accountLabel: string): Promise<void> {
    await this.pool.query('UPDATE provider_credentials SET account_label = $3 WHERE user_id = $1 AND provider_id = $2', [userId, providerId, accountLabel]);
  }

  async hiddenProviders(userId: string): Promise<Set<ProviderId>> {
    const result = await this.pool.query<{ provider_id: ProviderId }>(
      'SELECT provider_id FROM user_provider_preferences WHERE user_id = $1 AND is_hidden = true',
      [userId],
    );
    return new Set(result.rows.map((row) => row.provider_id));
  }

  async setProviderHidden(userId: string, providerId: ProviderId, isHidden: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_provider_preferences (user_id, provider_id, is_hidden) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, provider_id) DO UPDATE SET is_hidden = EXCLUDED.is_hidden`,
      [userId, providerId, isHidden],
    );
  }

  /**
   * The tools this user has an opinion about. A tool missing from the map is not
   * missing information: it means the default for its kind, which
   * `isToolPreferred` decides.
   */
  async toolPreferences(userId: string): Promise<ReadonlyMap<string, boolean>> {
    const result = await this.pool.query<{ tool_name: string; is_enabled: boolean }>(
      'SELECT tool_name, is_enabled FROM user_tool_preferences WHERE user_id = $1',
      [userId],
    );
    return new Map(result.rows.map((row) => [row.tool_name, row.is_enabled]));
  }

  async setToolPreference(userId: string, toolName: string, isEnabled: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_tool_preferences (user_id, tool_name, is_enabled) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, tool_name) DO UPDATE SET is_enabled = EXCLUDED.is_enabled`,
      [userId, toolName, isEnabled],
    );
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
