import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { ProviderId } from '../providers/types.js';
import { decryptSecret, encryptSecret } from '../security/secrets.js';
import type { AppDatabase } from './client.js';
import { providerCredentials } from './schema.js';

export type StoredCredential = {
  accessToken: string;
  refreshToken?: string;
  oauthClientId?: string;
  expiresAt?: Date;
  scopes: readonly string[];
};

const credentialPayloadSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  oauthClientId: z.string().min(1).optional(),
});
type CredentialPayload = z.infer<typeof credentialPayloadSchema>;

export function createConnectionStore(database: AppDatabase, config: Config) {
  return {
    async saveCredential(userId: string, providerId: ProviderId, credential: StoredCredential): Promise<void> {
      const payload: CredentialPayload = { accessToken: credential.accessToken };
      if (credential.refreshToken !== undefined) payload.refreshToken = credential.refreshToken;
      if (credential.oauthClientId !== undefined) payload.oauthClientId = credential.oauthClientId;
      const encryptedPayload = encryptSecret(JSON.stringify(payload), config.encryptionKey);
      await database
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
    },

    async getCredential(userId: string, providerId: ProviderId): Promise<StoredCredential | undefined> {
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
      const payload = credentialPayloadSchema.parse(JSON.parse(decryptSecret(row.encryptedPayload, config.encryptionKey)));
      return {
        accessToken: payload.accessToken,
        ...(payload.refreshToken === undefined ? {} : { refreshToken: payload.refreshToken }),
        ...(payload.oauthClientId === undefined ? {} : { oauthClientId: payload.oauthClientId }),
        ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
        scopes: row.scopes,
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

    /** Best-effort display name. A connection stays perfectly usable without one. */
    async setAccountLabel(userId: string, providerId: ProviderId, accountLabel: string): Promise<void> {
      await database
        .update(providerCredentials)
        .set({ accountLabel })
        .where(and(eq(providerCredentials.userId, userId), eq(providerCredentials.providerId, providerId)));
    },
  };
}
