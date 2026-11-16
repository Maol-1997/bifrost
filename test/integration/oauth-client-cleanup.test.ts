import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/server/database/client.js';
import { oauthClients } from '../../src/server/database/schema.js';
import { integrationEnvironment } from './environment.js';
import { createIntegrationHarness, type IntegrationHarness } from './harness.js';

let harness: IntegrationHarness;
let raw: DatabaseConnection;

beforeAll(async () => {
  harness = await createIntegrationHarness({ environment: integrationEnvironment() });
  raw = createDatabaseConnection(integrationEnvironment().databaseUrl, 1);
});

afterAll(async () => {
  await raw.client.end();
  await harness.close();
});

async function registerClient(kind: 'dynamic' | 'metadata-document', ageHours: number): Promise<string> {
  const clientId = kind === 'dynamic' ? `dcr-${randomUUID()}` : `https://client.example.test/${randomUUID()}`;
  await harness.database.upsertOAuthClient({
    clientId,
    clientName: 'Cleanup test client',
    redirectUris: ['http://localhost/callback'],
    registrationKind: kind,
    metadataExpiresAt: undefined,
  });
  await raw.database
    .update(oauthClients)
    .set({ createdAt: sql`now() - make_interval(hours => ${ageHours})` })
    .where(eq(oauthClients.clientId, clientId));
  return clientId;
}

describe('unused dynamic client cleanup against real Postgres', () => {
  it('deletes only old dynamic registrations that never got a grant', async () => {
    const abandoned = await registerClient('dynamic', 48);
    const recent = await registerClient('dynamic', 1);
    const inUse = await registerClient('dynamic', 48);
    const metadataDocument = await registerClient('metadata-document', 48);
    const userId = await harness.createUser();
    await harness.database.authorizeOAuthGrant({
      userId,
      clientId: inUse,
      scopes: ['mcp'],
      resource: 'https://bifrost.integration.test/mcp',
    });

    await harness.database.deleteUnusedDynamicClients();

    const remaining = await raw.database
      .select({ clientId: oauthClients.clientId })
      .from(oauthClients)
      .where(inArray(oauthClients.clientId, [abandoned, recent, inUse, metadataDocument]));
    expect(remaining.map((row) => row.clientId).sort()).toEqual([recent, inUse, metadataDocument].sort());
  });
});
