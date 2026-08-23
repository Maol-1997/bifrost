import { ClientError, ResponseBodyError } from 'openid-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { Coordinator } from '../src/server/coordination.js';
import type { StoredCredential } from '../src/server/database/index.js';
import { OAuthService } from '../src/server/oauth.js';
import type { ProviderId } from '../src/server/providers/types.js';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const USER_ID = '00000000-0000-4000-8000-000000000000';
const PROVIDER_ID = 'github';
const PROVIDER_STATE = 'provider-state';
const config = loadConfig({
  NODE_ENV: 'test',
  PUBLIC_URL: 'https://bifrost.example',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  GITHUB_CLIENT_ID: 'github-client',
  GITHUB_CLIENT_SECRET: 'github-secret',
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('provider credential refresh', () => {
  it('returns a token valid beyond the 60-second skew without locking or exchanging', async () => {
    setCurrentTime();
    const harness = createHarness(credentialExpiringIn(60_001));
    const lockSpy = vi.spyOn(harness.coordinator, 'withLock');

    await expect(harness.oauth.getOrRefreshAccessToken(USER_ID, PROVIDER_ID)).resolves.toBe('current-access');
    expect(lockSpy).not.toHaveBeenCalled();
    expect(harness.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('refreshes a token expiring exactly at the 60-second skew', async () => {
    setCurrentTime();
    const harness = createHarness(credentialExpiringIn(60_000));
    harness.refreshTokenGrant.mockResolvedValue({ access_token: 'refreshed-access', expires_in: 3_600 });

    await expect(harness.oauth.getOrRefreshAccessToken(USER_ID, PROVIDER_ID)).resolves.toBe('refreshed-access');
    expect(harness.refreshTokenGrant).toHaveBeenCalledOnce();
    expect(harness.saveCredential).toHaveBeenCalledWith(USER_ID, PROVIDER_ID, {
      accessToken: 'refreshed-access',
      refreshToken: 'current-refresh',
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      scopes: ['read:user'],
    });
  });

  it('returns the token refreshed by another caller during the lock wait', async () => {
    setCurrentTime();
    const harness = createHarness(credentialExpiringIn(0));
    harness.getCredential
      .mockResolvedValueOnce(credentialExpiringIn(0))
      .mockResolvedValueOnce({
        accessToken: 'other-caller-access',
        refreshToken: 'other-caller-refresh',
        expiresAt: new Date(NOW.getTime() + 3_600_000),
        scopes: ['read:user'],
      });

    await expect(harness.oauth.getOrRefreshAccessToken(USER_ID, PROVIDER_ID)).resolves.toBe('other-caller-access');
    expect(harness.refreshTokenGrant).not.toHaveBeenCalled();
    expect(harness.saveCredential).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing credential', undefined],
    ['a missing refresh token', {
      accessToken: 'expired-access',
      expiresAt: new Date(NOW.getTime()),
      scopes: ['read:user'],
    } satisfies StoredCredential],
  ])('requires reconnect for %s', async (_case, credential) => {
    setCurrentTime();
    const harness = createHarness(credential);

    await expect(harness.oauth.getOrRefreshAccessToken(USER_ID, PROVIDER_ID)).rejects.toMatchObject({
      name: 'ReconnectRequiredError',
      message: 'github connection expired; reconnect this provider',
    });
    expect(harness.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('preserves the prior refresh token when the provider omits one', async () => {
    setCurrentTime();
    const harness = createHarness(credentialExpiringIn(0));
    harness.refreshTokenGrant.mockResolvedValue({ access_token: 'refreshed-access', scope: 'repo' });

    await harness.oauth.getOrRefreshAccessToken(USER_ID, PROVIDER_ID);

    expect(harness.savedCredential()).toMatchObject({
      accessToken: 'refreshed-access',
      refreshToken: 'current-refresh',
    });
  });

  it('replaces the prior refresh token and scopes when the provider returns both', async () => {
    setCurrentTime();
    const harness = createHarness(credentialExpiringIn(0));
    harness.refreshTokenGrant.mockResolvedValue({
      access_token: 'refreshed-access',
      refresh_token: 'replacement-refresh',
      scope: 'repo,read:user',
    });

    await harness.oauth.getOrRefreshAccessToken(USER_ID, PROVIDER_ID);

    expect(harness.savedCredential()).toEqual({
      accessToken: 'refreshed-access',
      refreshToken: 'replacement-refresh',
      scopes: ['repo', 'read:user'],
    });
  });

  it.each([
    ['timeout', providerTimeout()],
    ['network failure', new TypeError('fetch failed')],
  ])('propagates a transient %s without replacing the credential', async (_case, transientError) => {
    setCurrentTime();
    const originalCredential = credentialExpiringIn(0);
    const harness = createHarness(originalCredential);
    harness.refreshTokenGrant.mockRejectedValue(transientError);

    await expect(harness.oauth.getOrRefreshAccessToken(USER_ID, PROVIDER_ID)).rejects.toBe(transientError);
    expect(harness.saveCredential).not.toHaveBeenCalled();
    expect(harness.storedCredential()).toBe(originalCredential);
  });

  it('requires reconnect when the provider rejects the refresh grant', async () => {
    setCurrentTime();
    const harness = createHarness(credentialExpiringIn(0));
    harness.refreshTokenGrant.mockRejectedValue(providerRejection());

    await expect(harness.oauth.getOrRefreshAccessToken(USER_ID, PROVIDER_ID)).rejects.toMatchObject({
      name: 'ReconnectRequiredError',
      message: 'github connection expired; reconnect this provider',
    });
    expect(harness.saveCredential).not.toHaveBeenCalled();
  });
});

describe('provider authorization completion', () => {
  it('consumes provider state before exchange so a failed attempt cannot be replayed to save credentials', async () => {
    const harness = createHarness();
    await seedProviderState(harness.coordinator);
    harness.authorizationCodeGrant
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ access_token: 'replayed-access' });

    await expect(harness.oauth.finishProvider('first-code', PROVIDER_STATE)).rejects.toThrow('fetch failed');
    await expect(harness.oauth.finishProvider('replayed-code', PROVIDER_STATE)).rejects.toThrow('invalid or expired');
    expect(harness.authorizationCodeGrant).toHaveBeenCalledOnce();
    expect(harness.saveCredential).not.toHaveBeenCalled();
  });

  it('saves the normalized credential before an optional account-label lookup fails', async () => {
    setCurrentTime();
    const events: string[] = [];
    const harness = createHarness();
    await seedProviderState(harness.coordinator);
    harness.authorizationCodeGrant.mockResolvedValue({
      access_token: 'connected-access',
      refresh_token: 'connected-refresh',
      expires_in: 120,
      scope: 'read:user repo',
    });
    harness.saveCredential.mockImplementation(async (...[, , credential]) => {
      events.push('save');
      harness.replaceStoredCredential(credential);
    });
    harness.readAccountLabel.mockImplementation(async () => {
      events.push('label');
      throw new Error('account API unavailable');
    });

    await expect(harness.oauth.finishProvider('code', PROVIDER_STATE)).resolves.toEqual({
      userId: USER_ID,
      providerId: PROVIDER_ID,
    });
    expect(harness.savedCredential()).toEqual({
      accessToken: 'connected-access',
      refreshToken: 'connected-refresh',
      expiresAt: new Date(NOW.getTime() + 120_000),
      scopes: ['read:user', 'repo'],
    });
    expect(events).toEqual(['save', 'label']);
    expect(harness.setAccountLabel).not.toHaveBeenCalled();
  });
});

function createHarness(initialCredential?: StoredCredential) {
  let storedCredential = initialCredential;
  const getCredential = vi.fn(async () => storedCredential);
  const saveCredential = vi.fn(async (...[, , credential]: [string, ProviderId, StoredCredential]) => {
    storedCredential = credential;
  });
  const setAccountLabel = vi.fn(async () => undefined);
  const database = {
    createSession: vi.fn(async () => ({ token: 'session-token', expiresAt: new Date(NOW.getTime() + 60_000) })),
    getCredential,
    saveCredential,
    setAccountLabel,
    upsertGoogleUser: vi.fn(async () => USER_ID),
  };
  const coordinator = new Coordinator();
  const authorizationCodeGrant = vi.fn(async (): Promise<unknown> => ({ access_token: 'connected-access' }));
  const refreshTokenGrant = vi.fn(async (): Promise<unknown> => ({ access_token: 'refreshed-access' }));
  const readAccountLabel = vi.fn(async (): Promise<string> => '@connected');
  const oauth = new OAuthService(config, database, coordinator, {
    authorizationCodeGrant,
    refreshTokenGrant,
    readAccountLabel,
  });

  return {
    authorizationCodeGrant,
    coordinator,
    getCredential,
    oauth,
    readAccountLabel,
    refreshTokenGrant,
    replaceStoredCredential: (credential: StoredCredential): void => { storedCredential = credential; },
    saveCredential,
    savedCredential: (): StoredCredential | undefined => saveCredential.mock.lastCall?.[2],
    setAccountLabel,
    storedCredential: (): StoredCredential | undefined => storedCredential,
  };
}

function credentialExpiringIn(milliseconds: number): StoredCredential {
  return {
    accessToken: 'current-access',
    refreshToken: 'current-refresh',
    expiresAt: new Date(NOW.getTime() + milliseconds),
    scopes: ['read:user'],
  };
}

function setCurrentTime(): void {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

async function seedProviderState(coordinator: Coordinator): Promise<void> {
  await coordinator.setEphemeral(`oauth:state:${PROVIDER_STATE}`, JSON.stringify({
    userId: USER_ID,
    providerId: PROVIDER_ID,
    verifier: 'v'.repeat(43),
    returnTo: '/',
  }), 600);
}

function providerRejection(): ResponseBodyError {
  return new ResponseBodyError('provider rejected refresh', {
    cause: { error: 'invalid_grant' },
    response: Response.json({ error: 'invalid_grant' }, { status: 400 }),
  });
}

function providerTimeout(): ClientError {
  const error = new ClientError('timed out');
  error.code = 'OAUTH_TIMEOUT';
  return error;
}
