import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { Coordinator } from '../src/server/coordination.js';
import type { Database } from '../src/server/db.js';
import { OAuthService } from '../src/server/oauth.js';
import { normalizeSlackTokenResponse } from '../src/server/providers/slack-oauth.js';

const config = loadConfig({
  NODE_ENV: 'test',
  PUBLIC_URL: 'https://bifrost.example',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GITHUB_CLIENT_ID: 'github-client',
  GITHUB_CLIENT_SECRET: 'github-secret',
  SLACK_CLIENT_ID: 'slack-client',
  SLACK_CLIENT_SECRET: 'slack-secret',
});
const coordinator = new Coordinator();
const oauth = new OAuthService(config, {} as Database, coordinator);

afterAll(async () => coordinator.close());
afterEach(() => vi.restoreAllMocks());

describe('OAuth authorization requests', () => {
  it('builds the Google authorization request with PKCE', async () => {
    const authorization = await oauth.startGoogleAuthorization('/');
    const url = new URL(authorization.location);
    expect({
      origin: url.origin,
      pathname: url.pathname,
      parameters: {
        ...Object.fromEntries(url.searchParams),
        codeChallengeIsValid: /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? ''),
        stateIsValid: /^[A-Za-z0-9_-]+$/.test(url.searchParams.get('state') ?? ''),
      },
    }).toEqual({
      origin: 'https://accounts.google.com',
      pathname: '/o/oauth2/v2/auth',
      parameters: {
        client_id: 'google-client',
        code_challenge: url.searchParams.get('code_challenge'),
        code_challenge_method: 'S256',
        codeChallengeIsValid: true,
        prompt: 'select_account',
        redirect_uri: 'https://bifrost.example/auth/google/callback',
        response_type: 'code',
        scope: 'openid email profile',
        state: url.searchParams.get('state'),
        stateIsValid: true,
      },
    });
    expect(authorization.browserNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.expiresInSeconds).toBe(600);
  });

  it('stores only the Google browser nonce hash in ephemeral state', async () => {
    const authorization = await oauth.startGoogleAuthorization('/');
    const state = new URL(authorization.location).searchParams.get('state');
    const stored = await coordinator.takeEphemeral(`oauth:state:${state}`);
    const storedState = JSON.parse(stored ?? '') as unknown;

    expect(stored).toBeDefined();
    expect(stored).not.toContain(authorization.browserNonce);
    expect(storedState).toMatchObject({ returnTo: '/' });
    if (!isRecord(storedState)) throw new Error('Stored OAuth state is not an object');
    expect(storedState.browserNonceHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects a Google callback from a browser without the initiating nonce', async () => {
    const authorization = await oauth.startGoogleAuthorization('/');
    const state = new URL(authorization.location).searchParams.get('state') ?? '';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(oauth.finishGoogle('code', state, undefined)).rejects.toThrow('browser binding');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a mismatched nonce and consumes the state once', async () => {
    const authorization = await oauth.startGoogleAuthorization('/');
    const state = new URL(authorization.location).searchParams.get('state') ?? '';

    await expect(oauth.finishGoogle('code', state, 'another-browser-nonce')).rejects.toThrow('browser binding');
    await expect(oauth.finishGoogle('code', state, authorization.browserNonce)).rejects.toThrow('invalid or expired');
  });

  it('accepts the initiating nonce before attempting the token exchange', async () => {
    const authorization = await oauth.startGoogleAuthorization('/');
    const state = new URL(authorization.location).searchParams.get('state') ?? '';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    );

    await expect(oauth.finishGoogle('code', state, authorization.browserNonce)).rejects.toThrow('Google sign-in failed');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('uses Slack official MCP user scopes', async () => {
    const url = new URL(await oauth.startProviderAuthorization('00000000-0000-4000-8000-000000000000', 'slack'));
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2_user/authorize');
    expect(url.searchParams.get('user_scope')).toBeNull();
    expect(url.searchParams.get('scope')).toBe('canvases:read,canvases:write,channels:history,channels:read,channels:write,chat:write,emoji:read,files:read,groups:history,groups:read,groups:write,im:history,im:write,mpim:history,mpim:read,mpim:write,reactions:write,search:read.files,search:read.im,search:read.mpim,search:read.private,search:read.public,search:read.users,users:read,users:read.email');
  });
});

describe('Google sign-in return paths', () => {
  it.each([
    '/',
    '/integrations',
    '/oauth/authorize?client_id=client#consent',
  ])('accepts same-origin absolute path %s', async (returnTo) => {
    const authorization = await oauth.startGoogleAuthorization(returnTo);
    expect(authorization.location).toContain('https://accounts.google.com/');
  });

  it.each([
    '',
    'integrations',
    'https://attacker.example/path',
    '//attacker.example/path',
    '///attacker.example/path',
    '/\\attacker.example/path',
    '\\attacker.example/path',
    '/path\\attacker',
    '/%5cattacker.example/path',
    '/%5Cattacker.example/path',
    '/%2fattacker.example/path',
    '/%2Fattacker.example/path',
  ])('rejects unsafe return path %s', async (returnTo) => {
    await expect(oauth.startGoogleAuthorization(returnTo)).rejects.toThrow();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('Slack OAuth token responses', () => {
  it('promotes the user grant over the bot grant', async () => {
    const response = Response.json({
      ok: true,
      access_token: 'bot-token',
      token_type: 'bot',
      authed_user: {
        access_token: 'user-token',
        refresh_token: 'user-refresh',
        expires_in: 3600,
        scope: 'channels:read',
      },
    });
    const normalized = await normalizeSlackTokenResponse(response);
    expect(await normalized.json()).toEqual({
      ok: true,
      access_token: 'user-token',
      token_type: 'bearer',
      refresh_token: 'user-refresh',
      expires_in: 3600,
      scope: 'channels:read',
      authed_user: {
        access_token: 'user-token',
        refresh_token: 'user-refresh',
        expires_in: 3600,
        scope: 'channels:read',
      },
    });
  });

  it('leaves rejected HTTP responses untouched', async () => {
    const response = Response.json({ error: 'invalid_code' }, { status: 400 });
    expect(await normalizeSlackTokenResponse(response)).toBe(response);
  });

  it('normalizes Slack user tokens returned at the top level', async () => {
    const response = Response.json({
      ok: true,
      access_token: 'user-token',
      token_type: 'user',
      refresh_token: 'user-refresh',
      expires_in: 3600,
      scope: 'channels:read',
    });
    const normalized = await normalizeSlackTokenResponse(response);
    expect(await normalized.json()).toEqual({
      ok: true,
      access_token: 'user-token',
      token_type: 'bearer',
      refresh_token: 'user-refresh',
      expires_in: 3600,
      scope: 'channels:read',
    });
  });
});
