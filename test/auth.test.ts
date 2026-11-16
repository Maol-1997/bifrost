import { Hono } from 'hono';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/server/config.js';
import type { Database } from '../src/server/database/index.js';
import { GoogleAccountConflictError } from '../src/server/database/users.js';
import {
  authenticateAgent,
  authenticateBrowser,
  clearGoogleOAuthNonceCookie,
  readGoogleOAuthNonceCookie,
  setGoogleOAuthNonceCookie,
} from '../src/server/http/auth.js';
import type { AppContext, AppDependencies, AppEnv } from '../src/server/http/context.js';
import { createPublicRoutes } from '../src/server/http/public.js';
import type { AgentIdentity, BrowserIdentity } from '../src/server/mcp.js';
import type { OAuthService } from '../src/server/oauth.js';

const USER_ID = '00000000-0000-4000-8000-000000000000';
const CLIENT_ID = 'test-client';
const PUBLIC_URL = 'https://bifrost.example';

describe('browser and agent authentication', () => {
  it('exposes precise resolver return types', () => {
    expectTypeOf<Awaited<ReturnType<typeof authenticateBrowser>>>().toEqualTypeOf<BrowserIdentity | undefined>();
    expectTypeOf<Awaited<ReturnType<typeof authenticateAgent>>>().toEqualTypeOf<AgentIdentity | undefined>();
  });

  it('resolves browser cookies only through the session table', async () => {
    const resolveSessionAndTouch = vi.fn().mockResolvedValue({
      sessionId: 'session-id',
      userId: USER_ID,
      email: 'sam@example.test',
      clientId: CLIENT_ID,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const resolveOAuthAccessTokenAndTouch = vi.fn();
    const context = authenticationContext(
      new Request(PUBLIC_URL, {
        headers: {
          authorization: 'Bearer agent-token',
          cookie: 'bifrost_session=session-token',
        },
      }),
      databaseWithResolvers(resolveSessionAndTouch, resolveOAuthAccessTokenAndTouch),
      testConfig(),
    );

    await expect(authenticateBrowser(context)).resolves.toMatchObject({
      kind: 'browser',
      sessionId: 'session-id',
      token: 'session-token',
    });
    expect(resolveSessionAndTouch).toHaveBeenCalledWith('session-token', undefined);
    expect(resolveOAuthAccessTokenAndTouch).not.toHaveBeenCalled();
  });

  it('resolves agent bearer tokens only through the OAuth token table', async () => {
    const resolveSessionAndTouch = vi.fn();
    const resolveOAuthAccessTokenAndTouch = vi.fn().mockResolvedValue({
      grantId: 'grant-id',
      userId: USER_ID,
      email: 'sam@example.test',
      clientId: CLIENT_ID,
      resource: `${PUBLIC_URL}/mcp`,
      scopes: ['mcp'],
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const context = authenticationContext(
      new Request(PUBLIC_URL, {
        headers: {
          authorization: 'Bearer agent-token',
          cookie: 'bifrost_session=session-token',
        },
      }),
      databaseWithResolvers(resolveSessionAndTouch, resolveOAuthAccessTokenAndTouch),
      testConfig(),
    );

    await expect(authenticateAgent(context)).resolves.toMatchObject({
      kind: 'agent',
      grantId: 'grant-id',
      token: 'agent-token',
    });
    expect(resolveOAuthAccessTokenAndTouch).toHaveBeenCalledWith('agent-token', undefined);
    expect(resolveSessionAndTouch).not.toHaveBeenCalled();
  });

  it.each(['production', 'test'] as const)(
    'rejects development headers in %s even when configured',
    async (environment) => {
      const config = { ...testConfig(environment), BIFROST_DEV_USER_ID: USER_ID };
      const context = authenticationContext(
        new Request(PUBLIC_URL, { headers: { 'x-bifrost-dev-user': USER_ID } }),
        databaseWithResolvers(vi.fn(), vi.fn()),
        config,
      );

      expect(await Promise.all([authenticateBrowser(context), authenticateAgent(context)])).toEqual([
        undefined,
        undefined,
      ]);
    },
  );

  it('rejects a development header naming a different user', async () => {
    const context = authenticationContext(
      new Request(PUBLIC_URL, { headers: { 'x-bifrost-dev-user': '00000000-0000-4000-8000-000000000001' } }),
      databaseWithResolvers(vi.fn(), vi.fn()),
      testConfig('development'),
    );

    expect(await Promise.all([authenticateBrowser(context), authenticateAgent(context)])).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('refuses a session and a bearer token once the account is no longer allowed to sign in', async () => {
    const identity = { userId: USER_ID, email: 'sam@former.example.test', clientId: CLIENT_ID };
    const expiresAt = new Date('2030-01-01T00:00:00.000Z');
    const database = databaseWithResolvers(
      vi.fn().mockResolvedValue({ ...identity, sessionId: 'session-id', expiresAt }),
      vi.fn().mockResolvedValue({
        ...identity,
        grantId: 'grant-id',
        resource: `${PUBLIC_URL}/mcp`,
        scopes: ['mcp'],
        expiresAt,
      }),
    );
    const request = () =>
      new Request(PUBLIC_URL, {
        headers: { authorization: 'Bearer agent-token', cookie: 'bifrost_session=session-token' },
      });
    const restricted = { ...testConfig(), accessPolicy: accessPolicy('example.test') };
    const stillListed = { ...testConfig(), accessPolicy: accessPolicy('former.example.test') };

    expect(
      await Promise.all([
        authenticateBrowser(authenticationContext(request(), database, restricted)),
        authenticateAgent(authenticationContext(request(), database, restricted)),
      ]),
    ).toEqual([undefined, undefined]);
    await expect(authenticateBrowser(authenticationContext(request(), database, stillListed))).resolves.toMatchObject({
      userId: USER_ID,
    });
    await expect(authenticateAgent(authenticationContext(request(), database, stillListed))).resolves.toMatchObject({
      userId: USER_ID,
    });
  });

  it('rejects a resolved agent token bound to another resource', async () => {
    const resolveOAuthAccessTokenAndTouch = vi.fn().mockResolvedValue({
      grantId: 'other-grant',
      userId: USER_ID,
      email: 'sam@example.test',
      clientId: CLIENT_ID,
      resource: 'https://other.example/mcp',
      scopes: ['mcp'],
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const context = authenticationContext(
      new Request(PUBLIC_URL, { headers: { authorization: 'Bearer other-resource-token' } }),
      databaseWithResolvers(vi.fn(), resolveOAuthAccessTokenAndTouch),
      testConfig(),
    );

    await expect(authenticateAgent(context)).resolves.toBeUndefined();
  });

  it('creates separate development identities for browser and agent paths', async () => {
    const config = testConfig('development');
    const request = new Request(PUBLIC_URL, {
      headers: { 'x-bifrost-dev-user': USER_ID },
    });
    const context = authenticationContext(request, databaseWithResolvers(vi.fn(), vi.fn()), config);

    const browserIdentity = await authenticateBrowser(context);
    const agentIdentity = await authenticateAgent(context);

    expect(browserIdentity).toMatchObject({ kind: 'browser', sessionId: 'development-session' });
    expect(agentIdentity).toMatchObject({ kind: 'agent', grantId: 'development-grant' });
  });
});

describe('Google OAuth browser nonce cookie', () => {
  it('sets a short-lived secure callback-only cookie in production', async () => {
    const app = cookieTestApp(testConfig('production'));
    const response = await app.request('/set');

    expect(response.headers.get('set-cookie')).toBe(
      'bifrost_google_oauth_nonce=browser-nonce; Max-Age=600; Path=/auth/google/callback; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('reads and clears the nonce cookie at callback', async () => {
    const app = cookieTestApp(testConfig());
    const response = await app.request('/clear', {
      headers: { cookie: 'bifrost_google_oauth_nonce=browser-nonce' },
    });

    expect(await response.text()).toBe('browser-nonce');
    expect(response.headers.get('set-cookie')).toContain(
      'bifrost_google_oauth_nonce=; Max-Age=0; Path=/auth/google/callback; HttpOnly; SameSite=Lax',
    );
  });

  it('passes the browser nonce to a successful callback and clears it', async () => {
    const finishGoogle = vi.fn().mockResolvedValue({
      sessionToken: 'session-token',
      userId: USER_ID,
      returnTo: '/integrations',
    });
    const app = googleCallbackTestApp(finishGoogle);
    const response = await app.request('/auth/google/callback?code=code&state=state', {
      headers: { cookie: 'bifrost_google_oauth_nonce=browser-nonce' },
    });

    expect(finishGoogle).toHaveBeenCalledWith('code', 'state', 'browser-nonce');
    expect(response.headers.get('location')).toBe('/integrations');
    expect(response.headers.get('set-cookie')).toContain('bifrost_google_oauth_nonce=; Max-Age=0');
  });

  it('clears the browser nonce when callback processing fails', async () => {
    const finishGoogle = vi.fn().mockRejectedValue(new Error('callback failed'));
    const app = googleCallbackTestApp(finishGoogle);
    const response = await app.request('/auth/google/callback?code=code&state=state', {
      headers: { cookie: 'bifrost_google_oauth_nonce=browser-nonce' },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('set-cookie')).toContain('bifrost_google_oauth_nonce=; Max-Age=0');
  });

  it('redirects an identity conflict to an actionable sign-in state', async () => {
    const finishGoogle = vi.fn().mockRejectedValue(new GoogleAccountConflictError());
    const app = googleCallbackTestApp(finishGoogle);

    const response = await app.request('/auth/google/callback?code=code&state=state', {
      headers: { cookie: 'bifrost_google_oauth_nonce=browser-nonce' },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/sign-in?conflict=true');
    expect(response.headers.get('set-cookie')).toContain('bifrost_google_oauth_nonce=; Max-Age=0');
  });
});

function accessPolicy(domain: string): Config['accessPolicy'] {
  return { allowedEmailDomains: new Set([domain]), allowedEmails: new Set() };
}

function testConfig(nodeEnvironment: 'development' | 'test' | 'production' = 'test'): Config {
  return loadConfig({
    NODE_ENV: nodeEnvironment,
    PUBLIC_URL,
    REDIS_URL: nodeEnvironment === 'production' ? 'redis://redis:6379' : undefined,
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    BIFROST_DEV_USER_ID: nodeEnvironment === 'development' ? USER_ID : '',
  });
}

function databaseWithResolvers(
  resolveSessionAndTouch: ReturnType<typeof vi.fn>,
  resolveOAuthAccessTokenAndTouch: ReturnType<typeof vi.fn>,
): Database {
  return { resolveSessionAndTouch, resolveOAuthAccessTokenAndTouch } as unknown as Database;
}

function authenticationContext(request: Request, database: Database, config: Config): AppContext {
  const dependencies = { config, database } as AppDependencies;
  return {
    req: { raw: request },
    get: (key: string) => {
      if (key === 'dependencies') return dependencies;
      throw new Error(`Unexpected context variable: ${key}`);
    },
  } as unknown as AppContext;
}

function cookieTestApp(config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const dependencies = { config } as AppDependencies;
  app.use('*', async (context, next) => {
    context.set('dependencies', dependencies);
    await next();
  });
  app.get('/set', (context) => {
    setGoogleOAuthNonceCookie(context, {
      location: 'https://accounts.google.com/o/oauth2/v2/auth',
      browserNonce: 'browser-nonce',
      expiresInSeconds: 600,
    });
    return context.text('ok');
  });
  app.get('/clear', (context) => {
    const nonce = readGoogleOAuthNonceCookie(context);
    clearGoogleOAuthNonceCookie(context);
    return context.text(nonce ?? 'missing');
  });
  return app;
}

function googleCallbackTestApp(finishGoogle: ReturnType<typeof vi.fn>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const dependencies = {
    config: testConfig(),
    oauth: { finishGoogle } as unknown as OAuthService,
  } as AppDependencies;
  app.use('*', async (context, next) => {
    context.set('dependencies', dependencies);
    await next();
  });
  app.route('/', createPublicRoutes());
  app.onError((_error, context) => context.text('failed', 500));
  return app;
}
