import { afterAll, describe, expect, it } from 'vitest';
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

describe('OAuth authorization requests', () => {
  it('builds the Google authorization request with PKCE', async () => {
    const url = new URL(await oauth.startGoogleAuthorization('/'));
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
  });

  it('uses Slack official MCP user scopes', async () => {
    const url = new URL(await oauth.startProviderAuthorization('00000000-0000-4000-8000-000000000000', 'slack'));
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2_user/authorize');
    expect(url.searchParams.get('user_scope')).toBeNull();
    expect(url.searchParams.get('scope')).toBe('canvases:read,canvases:write,channels:history,channels:read,channels:write,chat:write,emoji:read,files:read,groups:history,groups:read,groups:write,im:history,im:write,mpim:history,mpim:read,mpim:write,reactions:write,search:read.files,search:read.im,search:read.mpim,search:read.private,search:read.public,search:read.users,users:read,users:read.email');
  });
});

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
