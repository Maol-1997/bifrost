import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Coordinator } from '../../src/server/coordination.js';
import { OAuthService } from '../../src/server/oauth.js';
import { firstText } from '../helpers/mcp-protocol.js';
import { integrationEnvironment } from './environment.js';
import { createIntegrationHarness, type IntegrationHarness } from './harness.js';

const REFRESH_DURATION_MS = 200;

let harness: IntegrationHarness;
let refreshes = 0;
let adminUserId: string;

const refreshTokenGrant = async (): Promise<unknown> => {
  refreshes += 1;
  const generation = refreshes;
  // Long enough that a second caller arrives while the first exchange is in flight.
  await sleep(REFRESH_DURATION_MS);
  return { access_token: `refreshed-${generation}`, refresh_token: `refresh-${generation}`, expires_in: 3600, token_type: 'bearer' };
};

beforeAll(async () => {
  harness = await createIntegrationHarness({ environment: integrationEnvironment(), providerOAuth: { refreshTokenGrant } });
  adminUserId = await harness.createUser();
  await harness.connectProvider(adminUserId);
  await harness.decideTools(adminUserId, { github_echo: 'allowed_default_on' });
});

afterAll(async () => {
  await harness.close();
});

/** A user whose tool listing is already cached and whose provider token has just expired. */
async function userWithExpiredToken(): Promise<{ userId: string; bearer: string }> {
  const userId = await harness.createUser();
  await harness.connectProvider(userId, { accessToken: 'still-valid' });
  const bearer = await harness.issueBearer(userId);
  await harness.listTools(bearer);
  await harness.connectProvider(userId, {
    accessToken: 'expired', refreshToken: 'original-refresh', expiresAt: new Date(Date.now() - 1_000),
  });
  refreshes = 0;
  harness.upstream.reset();
  return { userId, bearer };
}

describe('provider token refresh under concurrency', () => {
  it('runs one exchange under Redis and serves the concurrent caller with its result', async () => {
    const { userId, bearer } = await userWithExpiredToken();

    const responses = await Promise.all([
      harness.callTool(bearer, 'github_echo', { message: 'one' }),
      harness.callTool(bearer, 'github_echo', { message: 'two' }),
    ]);
    const stored = await harness.database.getCredential(userId, 'github');

    expect({
      refreshes,
      texts: responses.map((response) => firstText(response.body)).sort(),
      upstreamBearers: [...new Set(harness.upstream.requests.map((request) => request.authorization))],
      stored: { accessToken: stored?.accessToken, refreshToken: stored?.refreshToken },
    }).toEqual({
      refreshes: 1,
      texts: ['echo:one', 'echo:two'],
      upstreamBearers: ['Bearer refreshed-1'],
      stored: { accessToken: 'refreshed-1', refreshToken: 'refresh-1' },
    });
  });

  it('runs one exchange and hands its result to a waiting caller with the in-process lock', async () => {
    const { userId } = await userWithExpiredToken();
    const singleProcess = new OAuthService(harness.config, harness.database, new Coordinator(), {
      authorizationCodeGrant: async () => { throw new Error('unexpected'); },
      refreshTokenGrant,
      readAccountLabel: async () => { throw new Error('unexpected'); },
    });

    const tokens = await Promise.all([
      singleProcess.getOrRefreshAccessToken(userId, 'github'),
      singleProcess.getOrRefreshAccessToken(userId, 'github'),
    ]);

    expect({ refreshes, tokens }).toEqual({ refreshes: 1, tokens: ['refreshed-1', 'refreshed-1'] });
  });

  it('drops an exchange whose row was replaced meanwhile, keeping the newer connection', async () => {
    const { userId } = await userWithExpiredToken();
    const reconnecting = new OAuthService(harness.config, harness.database, new Coordinator(), {
      authorizationCodeGrant: async () => { throw new Error('unexpected'); },
      refreshTokenGrant: async () => {
        // The user reconnects while the exchange for the old row is in flight.
        await harness.connectProvider(userId, { accessToken: 'reconnected' });
        return refreshTokenGrant();
      },
      readAccountLabel: async () => { throw new Error('unexpected'); },
    });

    const token = await reconnecting.getOrRefreshAccessToken(userId, 'github');
    const stored = await harness.database.getCredential(userId, 'github');

    expect({ token, stored: stored?.accessToken }).toEqual({ token: 'reconnected', stored: 'reconnected' });
  });
});
