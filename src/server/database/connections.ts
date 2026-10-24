import { and, asc, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { ProviderId } from '../providers/types.js';
import { decryptSecret, encryptSecret, KEYED_SECRET_VERSION } from '../security/secrets.js';
import type { AppDatabase } from './client.js';
import { providerCredentials } from './schema.js';

export type StoredCredential = {
  accessToken: string;
  refreshToken?: string;
  oauthClientId?: string;
  expiresAt?: Date;
  scopes: readonly string[];
};

/**
 * A credential as read back from its row. `version` changes on every write
 * (it is the fresh AES-GCM IV), so a caller that read the row can later ask
 * for a write that only lands if nobody replaced or removed it in between.
 */
export type StoredCredentialRecord = StoredCredential & { version: string };

export type CredentialReplacement = {
  userId: string;
  providerId: ProviderId;
  credential: StoredCredential;
  expectedVersion: string;
};

const credentialPayloadSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  oauthClientId: z.string().min(1).optional(),
});
type CredentialPayload = z.infer<typeof credentialPayloadSchema>;

export type CredentialRowKey = { userId: string; providerId: ProviderId };
export type CredentialKeyUsage = { version: number; keyId: string | undefined; count: number };

export function createConnectionStore(database: AppDatabase, config: Config) {
  return {
    async saveCredential(userId: string, providerId: ProviderId, credential: StoredCredential): Promise<void> {
      const columns = credentialColumns({ userId, providerId }, credential, config);
      await database
        .insert(providerCredentials)
        .values({ userId, providerId, ...columns })
        .onConflictDoUpdate({
          target: [providerCredentials.userId, providerCredentials.providerId],
          set: { ...columns, updatedAt: sql`now()` },
        });
    },

    /**
     * Writes a credential only over the exact row its writer read, for a token
     * refresh or a key rotation. A disconnect or a reconnect that landed in
     * between must win: the first would otherwise be silently undone, the second
     * overwritten with tokens for the previous account.
     */
    async replaceCredentialIfUnchanged(replacement: CredentialReplacement): Promise<boolean> {
      const rows = await database
        .update(providerCredentials)
        .set({ ...credentialColumns(replacement, replacement.credential, config), updatedAt: sql`now()` })
        .where(and(
          eq(providerCredentials.userId, replacement.userId),
          eq(providerCredentials.providerId, replacement.providerId),
          eq(sql`${providerCredentials.encryptedPayload}->>'iv'`, replacement.expectedVersion),
        ))
        .returning({ userId: providerCredentials.userId });
      return rows.length > 0;
    },

    async getCredential(userId: string, providerId: ProviderId): Promise<StoredCredentialRecord | undefined> {
      const [row] = await database
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
      const plaintext = decryptSecret(row.encryptedPayload, config.encryptionKeyring, credentialContext({ userId, providerId }));
      const payload = credentialPayloadSchema.parse(JSON.parse(plaintext));
      return {
        accessToken: payload.accessToken,
        ...(payload.refreshToken === undefined ? {} : { refreshToken: payload.refreshToken }),
        ...(payload.oauthClientId === undefined ? {} : { oauthClientId: payload.oauthClientId }),
        ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
        scopes: row.scopes,
        version: row.encryptedPayload.iv,
      };
    },

    async deleteCredential(userId: string, providerId: ProviderId): Promise<void> {
      await database
        .delete(providerCredentials)
        .where(and(eq(providerCredentials.userId, userId), eq(providerCredentials.providerId, providerId)));
    },

    async connectedProviders(userId: string): Promise<Set<ProviderId>> {
      const rows = await database
        .select({ providerId: providerCredentials.providerId })
        .from(providerCredentials)
        .where(eq(providerCredentials.userId, userId));
      return new Set(rows.map((row) => row.providerId));
    },

    /** Everything Integrations needs after OAuth has verified the credential. */
    async listConnections(userId: string): Promise<readonly { providerId: ProviderId; connectedAt: Date; accountLabel: string | undefined; scopes: readonly string[] }[]> {
      const rows = await database
        .select({
          providerId: providerCredentials.providerId,
          connectedAt: providerCredentials.createdAt,
          accountLabel: providerCredentials.accountLabel,
          scopes: providerCredentials.scopes,
        })
        .from(providerCredentials)
        .where(eq(providerCredentials.userId, userId));
      return rows.map((row) => ({ ...row, accountLabel: row.accountLabel ?? undefined }));
    },

    /**
     * The next rows, in key order after `after`, not yet sealed with the active
     * key. Keyset pagination keeps a long rotation from rescanning or skipping
     * rows while other writes land.
     */
    async credentialsToReencrypt(after: CredentialRowKey | undefined, limit: number): Promise<readonly CredentialRowKey[]> {
      const payload = providerCredentials.encryptedPayload;
      return database
        .select({ userId: providerCredentials.userId, providerId: providerCredentials.providerId })
        .from(providerCredentials)
        .where(and(
          or(
            sql`${payload}->>'version' is distinct from ${String(KEYED_SECRET_VERSION)}`,
            sql`${payload}->>'keyId' is distinct from ${config.encryptionKeyring.activeKeyId}`,
          ),
          after === undefined
            ? undefined
            : sql`(${providerCredentials.userId}, ${providerCredentials.providerId}) > (${after.userId}, ${after.providerId})`,
        ))
        .orderBy(asc(providerCredentials.userId), asc(providerCredentials.providerId))
        .limit(limit);
    },

    /** How many credentials each key currently protects, so an operator can see when a key is safe to retire. */
    async credentialKeyUsage(): Promise<readonly CredentialKeyUsage[]> {
      const rows = await database.execute<{ version: string | null; keyId: string | null; count: string }>(sql`
        select ${providerCredentials.encryptedPayload}->>'version' as "version",
          ${providerCredentials.encryptedPayload}->>'keyId' as "keyId",
          count(*) as "count"
        from ${providerCredentials}
        group by 1, 2
        order by 1, 2
      `);
      return rows.rows.map((row) => ({
        version: Number(row.version),
        keyId: row.keyId ?? undefined,
        count: Number(row.count),
      }));
    },

    /** Best-effort display name. A connection stays perfectly usable without one. */
    async setAccountLabel(userId: string, providerId: ProviderId, accountLabel: string): Promise<void> {
      await database
        .update(providerCredentials)
        .set({ accountLabel })
        .where(and(eq(providerCredentials.userId, userId), eq(providerCredentials.providerId, providerId)));
    },
  };
}

/** The associated data every credential is sealed with: its own row identity. */
function credentialContext(row: CredentialRowKey): string {
  return `${row.userId}:${row.providerId}`;
}

function credentialColumns(row: CredentialRowKey, credential: StoredCredential, config: Config) {
  const payload: CredentialPayload = { accessToken: credential.accessToken };
  if (credential.refreshToken !== undefined) payload.refreshToken = credential.refreshToken;
  if (credential.oauthClientId !== undefined) payload.oauthClientId = credential.oauthClientId;
  return {
    encryptedPayload: encryptSecret(JSON.stringify(payload), config.encryptionKeyring, credentialContext(row)),
    expiresAt: credential.expiresAt ?? null,
    scopes: [...credential.scopes],
  };
}
