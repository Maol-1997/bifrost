import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Config } from './config.js';
import { decryptSecret, encryptSecret, type EncryptedSecret } from './security/secrets.js';
import type { ProviderId } from './providers/types.js';

const { Pool } = pg;
const SESSION_BYTES = 32;
const SESSION_TTL_DAYS = 30;
const MILLISECONDS_PER_DAY = 86_400_000;

export type StoredCredential = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: readonly string[];
};

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

  async ensureDevelopmentUser(userId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@development.invalid`, 'Development User'],
    );
  }

  async createSession(userId: string, clientId: string): Promise<string> {
    const token = randomBytes(SESSION_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * MILLISECONDS_PER_DAY);
    await this.pool.query(
      'INSERT INTO sessions (token_hash, user_id, client_id, expires_at) VALUES ($1, $2, $3, $4)',
      [hashToken(token), userId, clientId, expiresAt],
    );
    return token;
  }

  async resolveSession(token: string): Promise<{ userId: string; clientId: string; expiresAt: Date } | undefined> {
    const result = await this.pool.query<{ user_id: string; client_id: string; expires_at: Date }>(
      'SELECT user_id, client_id, expires_at FROM sessions WHERE token_hash = $1 AND expires_at > now()',
      [hashToken(token)],
    );
    const row = result.rows[0];
    return row ? { userId: row.user_id, clientId: row.client_id, expiresAt: row.expires_at } : undefined;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
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
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
