import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
import { Coordinator } from '../../src/server/coordination.js';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/server/database/client.js';
import { rotateCredentials, type CredentialRotationStore } from '../../src/server/database/credential-rotation.js';
import { createDatabase, type Database } from '../../src/server/database/index.js';
import { providerCredentials } from '../../src/server/database/schema.js';
import { OAuthService, providerRefreshLockKey } from '../../src/server/oauth.js';
import { RedisRuntime } from '../../src/server/redis.js';
import type { EncryptedSecret } from '../../src/server/security/secrets.js';
import { integrationEnvironment } from './environment.js';

const environment = integrationEnvironment();
const LEGACY_KEY = randomBytes(32);
const FIRST_KEY = randomBytes(32).toString('base64');
const SECOND_KEY = randomBytes(32).toString('base64');

function databaseFor(keys: Record<string, string>, activeKeyId: string, legacy = true): Database {
  return createDatabase(loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: environment.databaseUrl,
    ...(legacy ? { ENCRYPTION_KEY: LEGACY_KEY.toString('base64') } : {}),
    ENCRYPTION_KEYS: JSON.stringify(keys),
    ENCRYPTION_ACTIVE_KEY_ID: activeKeyId,
  }));
}

let raw: DatabaseConnection;
let redis: RedisRuntime;
let coordinator: Coordinator;
/** The previous deployment: writes with the first key. */
let before: Database;
/** After the keyring gains the second key and makes it active. */
let after: Database;
/** Once rotation is done: only the second key remains. */
let retired: Database;

beforeAll(async () => {
  raw = createDatabaseConnection(environment.databaseUrl, 2);
  const connected = await RedisRuntime.connect({ required: true, url: environment.redisUrl });
  if (!connected) throw new Error('Redis is required for integration tests');
  redis = connected;
  coordinator = new Coordinator(redis.commands);
  before = databaseFor({ first: FIRST_KEY }, 'first');
  after = databaseFor({ first: FIRST_KEY, second: SECOND_KEY }, 'second');
  retired = databaseFor({ second: SECOND_KEY }, 'second', false);
});

afterAll(async () => {
  await Promise.all([before.close(), after.close(), retired.close(), raw.client.end(), redis.close()]);
});

beforeEach(async () => {
  // Other files leave credentials sealed with their own throwaway keys.
  await raw.database.delete(providerCredentials);
});

async function user(): Promise<string> {
  const userId = randomUUID();
  await after.ensureDevelopmentUser(userId);
  return userId;
}

/** A row exactly as the release before key ids wrote it: no key id, no associated data. */
async function insertLegacyCredential(userId: string, payload: Record<string, string>, expiresAt?: Date): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', LEGACY_KEY, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  await raw.database.insert(providerCredentials).values({
    userId,
    providerId: 'github',
    encryptedPayload: { version: 1, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), authTag: cipher.getAuthTag().toString('base64') },
    scopes: ['repo'],
    expiresAt: expiresAt ?? null,
  });
}

async function payloadOf(userId: string): Promise<EncryptedSecret> {
  const [row] = await raw.database
    .select({ payload: providerCredentials.encryptedPayload })
    .from(providerCredentials)
    .where(eq(providerCredentials.userId, userId));
  return row!.payload;
}

function rotate(store: CredentialRotationStore, apply: boolean) {
  return rotateCredentials({
    store,
    withRowLock: (row, operation) => coordinator.withLock(providerRefreshLockKey(row.userId, row.providerId), operation),
    apply,
    batchSize: 2,
  });
}

describe('credential key rotation against Postgres and Redis', () => {
  it('re-seals legacy and retired-key rows under the active key; a dry run changes nothing', async () => {
    const [legacy, first, second] = await Promise.all([user(), user(), user()]);
    await insertLegacyCredential(legacy, { accessToken: 'legacy-token', refreshToken: 'legacy-refresh' });
    await before.saveCredential(first, 'github', { accessToken: 'first-token', scopes: ['repo'] });
    await after.saveCredential(second, 'github', { accessToken: 'second-token', scopes: ['repo'] });
    const untouched = await Promise.all([legacy, first, second].map(payloadOf));

    const dryRun = await rotate(after, false);
    const afterDryRun = await Promise.all([legacy, first, second].map(payloadOf));
    const applied = await rotate(after, true);
    const tokens = await Promise.all([legacy, first, second].map(async (userId) => (await retired.getCredential(userId, 'github'))?.accessToken));
    const legacyRecord = await retired.getCredential(legacy, 'github');

    expect({
      dryRun: { pending: dryRun.pending, readable: dryRun.readable, reencrypted: dryRun.reencrypted },
      unchangedByDryRun: afterDryRun,
      applied: { pending: applied.pending, reencrypted: applied.reencrypted, failed: applied.failed },
      usage: await after.credentialKeyUsage(),
      tokens,
      legacyRecord: { refreshToken: legacyRecord?.refreshToken, scopes: legacyRecord?.scopes },
      secondRun: (await rotate(after, true)).pending,
    }).toEqual({
      dryRun: { pending: 2, readable: 2, reencrypted: 0 },
      unchangedByDryRun: untouched,
      applied: { pending: 2, reencrypted: 2, failed: [] },
      usage: [{ version: 2, keyId: 'second', count: 3 }],
      tokens: ['legacy-token', 'first-token', 'second-token'],
      legacyRecord: { refreshToken: 'legacy-refresh', scopes: ['repo'] },
      secondRun: 0,
    });
  });

  it('refuses a credential copied onto another row and one sealed by a key that was removed', async () => {
    const [owner, victim] = await Promise.all([user(), user()]);
    await after.saveCredential(owner, 'github', { accessToken: 'owner-token', scopes: [] });
    await after.saveCredential(victim, 'github', { accessToken: 'victim-token', scopes: [] });
    await raw.database.execute(sql`
      update ${providerCredentials}
      set encrypted_payload = (select encrypted_payload from ${providerCredentials} where user_id = ${owner})
      where user_id = ${victim}
    `);
    const sealedByFirst = await user();
    await before.saveCredential(sealedByFirst, 'github', { accessToken: 'first-token', scopes: [] });

    await expect(after.getCredential(victim, 'github')).rejects.toThrow();
    await expect(retired.getCredential(sealedByFirst, 'github')).rejects.toThrow('Unknown encryption key id: first');
    expect((await after.getCredential(owner, 'github'))?.accessToken).toBe('owner-token');
  });

  it('reports rows no configured key can open instead of skipping them silently', async () => {
    const sealedByFirst = await user();
    await before.saveCredential(sealedByFirst, 'github', { accessToken: 'first-token', scopes: [] });

    const report = await rotate(retired, true);

    expect(report.failed).toEqual([{ userId: sealedByFirst, providerId: 'github', reason: 'Unknown encryption key id: first' }]);
  });

  it('keeps a refresh that landed between the rotation’s read and write', async () => {
    const userId = await user();
    await insertLegacyCredential(userId, { accessToken: 'stale', refreshToken: 'stale-refresh' });
    const racing: CredentialRotationStore = {
      credentialsToReencrypt: (cursor, limit) => after.credentialsToReencrypt(cursor, limit),
      replaceCredentialIfUnchanged: (replacement) => after.replaceCredentialIfUnchanged(replacement),
      // A refresh from a process that cannot see the shared lock writes right after the rotation reads.
      getCredential: async (id, providerId) => {
        const read = await after.getCredential(id, providerId);
        await after.replaceCredentialIfUnchanged({
          userId: id, providerId, expectedVersion: read!.version,
          credential: { accessToken: 'refreshed', refreshToken: 'refreshed-refresh', scopes: ['repo'] },
        });
        return read;
      },
    };

    const report = await rotate(racing, true);
    const stored = await after.getCredential(userId, 'github');

    expect({ reencrypted: report.reencrypted, changed: report.changedConcurrently, token: stored?.accessToken, refresh: stored?.refreshToken })
      .toEqual({ reencrypted: 0, changed: 1, token: 'refreshed', refresh: 'refreshed-refresh' });
  });

  it('waits out a refresh holding the lock instead of making it discard a rotated token', async () => {
    const userId = await user();
    await insertLegacyCredential(userId, { accessToken: 'expired', refreshToken: 'single-use-refresh' }, new Date(Date.now() - 120_000));
    let finishExchange = (): void => undefined;
    let exchangeStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => { exchangeStarted = resolve; });
    const oauth = new OAuthService(loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY: LEGACY_KEY.toString('base64'), GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }), after, coordinator, {
      authorizationCodeGrant: async () => { throw new Error('unexpected'); },
      readAccountLabel: async () => { throw new Error('unexpected'); },
      refreshTokenGrant: async () => {
        exchangeStarted();
        await new Promise<void>((resolve) => { finishExchange = resolve; });
        return { access_token: 'rotated-by-provider', refresh_token: 'next-refresh', expires_in: 3600, token_type: 'bearer' };
      },
    });

    const refresh = oauth.getOrRefreshAccessToken(userId, 'github');
    await started;
    const duringRefresh = await rotate(after, true);
    finishExchange();
    const refreshedToken = await refresh;
    const stored = await after.getCredential(userId, 'github');
    const rerun = await rotate(after, true);

    expect({
      duringRefresh: { busy: duringRefresh.busy, reencrypted: duringRefresh.reencrypted },
      refreshedToken,
      stored: { accessToken: stored?.accessToken, refreshToken: stored?.refreshToken },
      storedUnderActiveKey: await payloadOf(userId).then((payload) => payload.version === 2 && payload.keyId === 'second'),
      rerunPending: rerun.pending,
    }).toEqual({
      duringRefresh: { busy: 1, reencrypted: 0 },
      refreshedToken: 'rotated-by-provider',
      stored: { accessToken: 'rotated-by-provider', refreshToken: 'next-refresh' },
      storedUnderActiveKey: true,
      rerunPending: 0,
    });
  });
});
