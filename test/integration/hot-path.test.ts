import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/server/database/client.js';
import { oauthAccessTokens, oauthGrants } from '../../src/server/database/schema.js';
import { hashToken } from '../../src/server/database/token-hash.js';
import { firstText, toolNotFound } from '../helpers/mcp-protocol.js';
import { integrationEnvironment } from './environment.js';
import { createIntegrationHarness, type IntegrationHarness, type McpResponse } from './harness.js';

let harness: IntegrationHarness;
let raw: DatabaseConnection;
let adminUserId: string;
let refreshes = 0;

beforeAll(async () => {
  harness = await createIntegrationHarness({
    environment: integrationEnvironment(),
    providerOAuth: {
      refreshTokenGrant: async () => {
        refreshes += 1;
        return { access_token: `refreshed-${refreshes}`, refresh_token: 'next', expires_in: 3600, token_type: 'bearer' };
      },
    },
  });
  raw = createDatabaseConnection(integrationEnvironment().databaseUrl, 2);
  adminUserId = await harness.createUser();
  await harness.connectProvider(adminUserId);
  await harness.decideTools(adminUserId, { github_echo: 'allowed_default_on', github_create_note: 'allowed_default_off' });
});

afterAll(async () => {
  await raw.client.end();
  await harness.close();
});

beforeEach(() => {
  harness.upstream.reset();
});

async function connectedAgent(): Promise<{ userId: string; bearer: string }> {
  const userId = await harness.createUser();
  await harness.connectProvider(userId, { accessToken: `access-${userId}` });
  return { userId, bearer: await harness.issueBearer(userId) };
}

const text = (response: McpResponse): string | undefined => firstText(response.body);

describe('pooled upstream MCP clients', () => {
  it('connects once and reuses the client for discovery and every later call', async () => {
    const agent = await connectedAgent();

    await harness.listTools(agent.bearer);
    const results = [
      await harness.callTool(agent.bearer, 'github_echo', { message: 'one' }),
      await harness.callTool(agent.bearer, 'github_echo', { message: 'two' }),
    ].map(text);

    expect({ results, initializations: harness.upstream.count('initialize'), lists: harness.upstream.count('tools/list'), calls: harness.upstream.count('tools/call') })
      .toEqual({ results: ['echo:one', 'echo:two'], initializations: 1, lists: 1, calls: 2 });
  });

  it('shares one connection between concurrent calls', async () => {
    const agent = await connectedAgent();
    await harness.listTools(agent.bearer);
    harness.upstream.reset();

    await Promise.all(['a', 'b', 'c', 'd'].map(async (message) => harness.callTool(agent.bearer, 'github_echo', { message })));

    expect({ initializations: harness.upstream.count('initialize'), calls: harness.upstream.count('tools/call') })
      .toEqual({ initializations: 0, calls: 4 });
  });

  it('opens a new connection with the new token after a provider refresh', async () => {
    const agent = await connectedAgent();
    await harness.callTool(agent.bearer, 'github_echo', { message: 'before' });
    await harness.connectProvider(agent.userId, {
      accessToken: 'expired', refreshToken: 'refresh', expiresAt: new Date(Date.now() - 120_000),
    });
    harness.upstream.reset();
    const refreshedBefore = refreshes;

    const after = await harness.callTool(agent.bearer, 'github_echo', { message: 'after' });

    expect({
      after: text(after),
      refreshed: refreshes - refreshedBefore,
      initializations: harness.upstream.count('initialize'),
      callBearer: harness.upstream.requests.find((request) => request.method === 'tools/call')?.authorization,
    }).toEqual({ after: 'echo:after', refreshed: 1, initializations: 1, callBearer: `Bearer refreshed-${refreshes}` });
  });

  it('sends a failed call once, never retries it, and reconnects for the next call', async () => {
    const agent = await connectedAgent();
    await harness.callTool(agent.bearer, 'github_echo', { message: 'warm' });
    harness.upstream.reset();
    harness.upstream.failNextCall();

    const failed = await harness.callTool(agent.bearer, 'github_echo', { message: 'lost' });
    const callsAfterFailure = harness.upstream.count('tools/call');
    const next = await harness.callTool(agent.bearer, 'github_echo', { message: 'next' });

    expect({
      failed: { isError: failed.body.result?.isError, text: text(failed) },
      callsAfterFailure,
      next: text(next),
      initializations: harness.upstream.count('initialize'),
    }).toEqual({
      failed: { isError: true, text: 'Tool call failed' },
      callsAfterFailure: 1,
      next: 'echo:next',
      initializations: 1,
    });
  });

  it('resends once on a fresh session when the provider dropped the pooled one, running the tool once', async () => {
    const agent = await connectedAgent();
    await harness.callTool(agent.bearer, 'github_echo', { message: 'warm' });
    harness.upstream.reset();
    harness.upstream.expireSessions();

    const called = await harness.callTool(agent.bearer, 'github_echo', { message: 'after expiry' });

    expect({
      text: text(called),
      executions: harness.upstream.executions,
      callsReceived: harness.upstream.count('tools/call'),
      initializations: harness.upstream.count('initialize'),
    }).toEqual({ text: 'echo:after expiry', executions: 1, callsReceived: 2, initializations: 1 });
  });

  it('closes the client when the user disconnects the provider', async () => {
    const agent = await connectedAgent();
    await harness.callTool(agent.bearer, 'github_echo', { message: 'connected' });
    const pooledBefore = harness.upstreamClients.size;

    const status = await harness.disconnectProvider(agent.userId);

    expect({ status, closed: pooledBefore - harness.upstreamClients.size }).toEqual({ status: 200, closed: 1 });
  });
});

describe('per-user visibility in one query', () => {
  it('returns exactly what the three separate reads return', async () => {
    const empty = await harness.createUser();
    const busy = await harness.createUser();
    await harness.connectProvider(busy, {}, 'github');
    await harness.connectProvider(busy, {}, 'linear');
    await harness.connectProvider(busy, {}, 'notion');
    await harness.database.setProviderHidden(busy, 'linear', true);
    await harness.database.setProviderHidden(busy, 'notion', false);
    await harness.database.setProviderHidden(busy, 'sentry', true);
    await harness.database.setToolPreference(busy, 'github_echo', false);
    await harness.database.setToolPreference(busy, 'github_create_note', true);

    const separate = async (userId: string) => ({
      connectedProviders: await harness.database.connectedProviders(userId),
      hiddenProviders: await harness.database.hiddenProviders(userId),
      toolPreferences: await harness.database.toolPreferences(userId),
    });

    expect([await harness.database.userVisibilityState(empty), await harness.database.userVisibilityState(busy)])
      .toEqual([await separate(empty), await separate(busy)]);
    expect(await harness.database.userVisibilityState(busy)).toEqual({
      connectedProviders: new Set(['github', 'linear', 'notion']),
      hiddenProviders: new Set(['linear', 'sentry']),
      toolPreferences: new Map([['github_echo', false], ['github_create_note', true]]),
    });
  });

  it('still applies an administrator policy change to the next request', async () => {
    const agent = await connectedAgent();
    const before = await harness.listTools(agent.bearer);

    await harness.decideTools(adminUserId, { github_create_note: 'allowed_default_on' });
    const after = await harness.listTools(agent.bearer);
    await harness.decideTools(adminUserId, { github_create_note: 'allowed_default_off' });

    expect({ before: before.body.result?.tools?.map((tool) => tool.name).sort(), after: after.body.result?.tools?.map((tool) => tool.name).sort() })
      .toEqual({ before: ['github_echo'], after: ['github_create_note', 'github_echo'] });
  });
});

describe('grant last-use stamping', () => {
  async function grantOf(bearer: string): Promise<{ id: string; lastUsedAt: Date; userAgent: string | null }> {
    const [row] = await raw.database
      .select({ id: oauthGrants.id, lastUsedAt: oauthGrants.lastUsedAt, userAgent: oauthGrants.userAgent })
      .from(oauthGrants)
      .innerJoin(oauthAccessTokens, eq(oauthAccessTokens.grantId, oauthGrants.id))
      .where(eq(oauthAccessTokens.tokenHash, hashToken(bearer)));
    return row!;
  }

  async function backdate(grantId: string, seconds: number): Promise<void> {
    await raw.database.execute(sql`update oauth_grants set last_used_at = now() - make_interval(secs => ${seconds}) where id = ${grantId}`);
  }

  it('writes once the stamp is older than a minute and not again within the window', async () => {
    const agent = await connectedAgent();
    const grant = await grantOf(agent.bearer);
    await backdate(grant.id, 120);
    const stale = (await grantOf(agent.bearer)).lastUsedAt;

    await harness.database.resolveOAuthAccessTokenAndTouch(agent.bearer, 'agent/1.0');
    const stamped = await grantOf(agent.bearer);
    await harness.database.resolveOAuthAccessTokenAndTouch(agent.bearer, 'agent/2.0');
    await harness.listTools(agent.bearer);
    const unchanged = await grantOf(agent.bearer);

    expect({
      advanced: stamped.lastUsedAt.getTime() > stale.getTime(),
      userAgent: stamped.userAgent,
      unchanged: unchanged.lastUsedAt.getTime() === stamped.lastUsedAt.getTime() && unchanged.userAgent === 'agent/1.0',
    }).toEqual({ advanced: true, userAgent: 'agent/1.0', unchanged: true });
  });

  it('still rejects revoked and expired tokens inside the window', async () => {
    const revoked = await connectedAgent();
    const expired = await connectedAgent();
    await harness.listTools(revoked.bearer);
    await harness.listTools(expired.bearer);

    const revokedGrant = await grantOf(revoked.bearer);
    await harness.database.revokeOAuthGrant(revoked.userId, revokedGrant.id);
    await raw.database.update(oauthAccessTokens).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(oauthAccessTokens.tokenHash, hashToken(expired.bearer)));

    expect({
      revoked: (await harness.listTools(revoked.bearer)).status,
      expired: (await harness.listTools(expired.bearer)).status,
      unknown: await harness.database.resolveOAuthAccessTokenAndTouch(randomUUID()),
    }).toEqual({ revoked: 401, expired: 401, unknown: undefined });
  });
});

describe('tools/call resolves only the named tool', () => {
  const notFound = (response: McpResponse): string | undefined => toolNotFound(response.body);

  it('discovers only the named tool’s provider on a cold cache', async () => {
    const userId = await harness.createUser();
    await harness.connectProvider(userId, {}, 'github');
    await harness.connectProvider(userId, {}, 'linear');
    const bearer = await harness.issueBearer(userId);

    const called = await harness.callTool(bearer, 'github_echo', { message: 'only github' });

    expect({ text: text(called), upstreamLists: harness.upstream.count('tools/list') })
      .toEqual({ text: 'echo:only github', upstreamLists: 1 });
  });

  it('answers a hidden provider’s tool and a changed contract with the same error as an unknown tool', async () => {
    const hidden = await connectedAgent();
    await harness.database.setProviderHidden(hidden.userId, 'github', true);
    const changed = await connectedAgent();
    await harness.callTool(changed.bearer, 'github_echo', { message: 'approved contract' });
    harness.upstream.setTools([{ name: 'echo', description: 'Returns the message, now with a new contract.', readOnly: true }]);
    await harness.toolDiscovery.invalidateProvider(changed.userId, 'github');
    harness.upstream.requests.length = 0;

    const responses = {
      hidden: notFound(await harness.callTool(hidden.bearer, 'github_echo', { message: 'x' })),
      changed: notFound(await harness.callTool(changed.bearer, 'github_echo', { message: 'x' })),
      unknown: notFound(await harness.callTool(changed.bearer, 'github_never_existed', { message: 'x' })),
    };

    expect({ responses, upstreamCalls: harness.upstream.count('tools/call') }).toEqual({
      responses: { hidden: 'Tool github_echo not found', changed: 'Tool github_echo not found', unknown: 'Tool github_never_existed not found' },
      upstreamCalls: 0,
    });
  });
});
