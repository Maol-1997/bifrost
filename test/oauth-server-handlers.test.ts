import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { authorizationCodeKey, handleAuthorize, handleConsent } from '../src/server/oauth-server/authorize.js';
import type { OAuthHttpResult, OAuthServerContext } from '../src/server/oauth-server/context.js';
import { handleRevoke, handleToken } from '../src/server/oauth-server/token.js';
import type { Coordinator } from '../src/server/coordination.js';
import type { Database, OAuthTokenPair, RefreshOutcome, StoredOAuthClient } from '../src/server/database/index.js';

vi.mock('../src/server/logger.js', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const PUBLIC_URL = 'https://bifrost.example';
const REDIRECT_URI = 'https://client.example/callback';
const CLIENT_ID = 'registered-client';
const USER_ID = '9aa3f9d9-99b2-4be8-aa05-89db020c1d80';
const OTHER_USER_ID = '850ec68a-c662-4697-9497-976755abde77';
const RESOURCE = `${PUBLIC_URL}/mcp`;
const STATE = 'client-state';
const CODE_VERIFIER = 'test-verifier-that-is-at-least-forty-three-characters-long';
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');
const AUTHORIZATION_CODE = 'test-authorization-code';
const CONSENT_TOKEN = 'test-consent-token';

const REGISTERED_CLIENT: StoredOAuthClient = {
  clientId: CLIENT_ID,
  clientName: 'Test MCP Client',
  redirectUris: [REDIRECT_URI],
  registrationKind: 'dynamic',
  metadataExpiresAt: undefined,
};

const TOKEN_PAIR: OAuthTokenPair = {
  accessToken: 'issued-access-token',
  refreshToken: 'issued-refresh-token',
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
};

type DatabaseFake = Pick<Database,
  | 'authorizeOAuthGrant'
  | 'getOAuthClient'
  | 'getUser'
  | 'hasOAuthGrant'
  | 'revokeOAuthToken'
  | 'rotateOAuthRefreshToken'
>;

type CoordinatorFake = Pick<Coordinator, 'setEphemeral' | 'takeEphemeral'>;

type HarnessOptions = {
  ephemeralValues?: ReadonlyMap<string, string>;
  refreshOutcome?: RefreshOutcome;
};

type HandlerHarness = {
  context: OAuthServerContext;
  coordinator: CoordinatorFake;
  database: DatabaseFake;
  ephemeralValues: Map<string, string>;
};

function createHarness(options: HarnessOptions = {}): HandlerHarness {
  const ephemeralValues = new Map(options.ephemeralValues);
  const database: DatabaseFake = {
    authorizeOAuthGrant: vi.fn(async () => TOKEN_PAIR),
    getOAuthClient: vi.fn(async () => REGISTERED_CLIENT),
    getUser: vi.fn(async () => ({ name: 'Test User', email: 'user@example.com' })),
    hasOAuthGrant: vi.fn(async () => false),
    revokeOAuthToken: vi.fn(async () => undefined),
    rotateOAuthRefreshToken: vi.fn(async (): Promise<RefreshOutcome> => options.refreshOutcome ?? { kind: 'unknown' }),
  };
  const coordinator: CoordinatorFake = {
    setEphemeral: vi.fn(async (key: string, value: string) => {
      ephemeralValues.set(key, value);
    }),
    takeEphemeral: vi.fn(async (key: string) => {
      const value = ephemeralValues.get(key);
      ephemeralValues.delete(key);
      return value;
    }),
  };
  const context = {
    config: {
      OAUTH_ENABLE_CLIENT_ID_METADATA_DOCUMENTS: false,
      PUBLIC_URL,
    },
    coordinator,
    database,
  } as unknown as OAuthServerContext;
  return { context, coordinator, database, ephemeralValues };
}

function authorizationUrl(overrides: Readonly<Record<string, string>> = {}): URL {
  const parameters = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    response_type: 'code',
    scope: 'mcp',
    state: STATE,
    ...overrides,
  });
  return new URL(`${PUBLIC_URL}/oauth/authorize?${parameters.toString()}`);
}

function pendingConsent(userId = USER_ID): string {
  return JSON.stringify({
    clientId: CLIENT_ID,
    clientName: REGISTERED_CLIENT.clientName,
    userId,
    redirectUri: REDIRECT_URI,
    codeChallenge: CODE_CHALLENGE,
    scopes: ['mcp'],
    resource: RESOURCE,
    state: STATE,
  });
}

function authorizationPayload(): string {
  return JSON.stringify({
    clientId: CLIENT_ID,
    userId: USER_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: CODE_CHALLENGE,
    scopes: ['mcp'],
    resource: RESOURCE,
  });
}

function consentBody(decision = 'approve'): URLSearchParams {
  return new URLSearchParams({ consent_token: CONSENT_TOKEN, decision });
}

function authorizationCodeBody(overrides: Readonly<Record<string, string>> = {}): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code: AUTHORIZATION_CODE,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: CODE_VERIFIER,
    resource: RESOURCE,
    ...overrides,
  });
}

function authorizationCodeHarness(): HandlerHarness {
  return createHarness({
    ephemeralValues: new Map([[authorizationCodeKey(AUTHORIZATION_CODE), authorizationPayload()]]),
  });
}

function htmlSummary(result: OAuthHttpResult): { kind: string; status: number; body: string } {
  if (result.kind !== 'html') throw new Error(`Expected an HTML result, received ${result.kind}`);
  return { kind: result.kind, status: result.status, body: result.body };
}

function htmlErrorSummary(result: OAuthHttpResult, expectedText: string): { kind: string; status: number; includesExpectedText: boolean } {
  const summary = htmlSummary(result);
  return { kind: summary.kind, status: summary.status, includesExpectedText: summary.body.includes(expectedText) };
}

function redirectSummary(result: OAuthHttpResult): Record<string, string | boolean | null> {
  if (result.kind !== 'redirect') throw new Error(`Expected a redirect result, received ${result.kind}`);
  const location = new URL(result.location);
  return {
    originAndPath: `${location.origin}${location.pathname}`,
    error: location.searchParams.get('error'),
    state: location.searchParams.get('state'),
    issuer: location.searchParams.get('iss'),
    hasCode: location.searchParams.has('code'),
  };
}

function jsonSummary(result: OAuthHttpResult): { kind: string; status: number; body: unknown } {
  if (result.kind !== 'json') throw new Error(`Expected a JSON result, received ${result.kind}`);
  return { kind: result.kind, status: result.status, body: result.body };
}

function tokenResponseSummary(result: OAuthHttpResult): Record<string, unknown> {
  const summary = jsonSummary(result);
  if (typeof summary.body !== 'object' || summary.body === null) throw new Error('Expected a token response object');
  const body = summary.body as Record<string, unknown>;
  return {
    kind: summary.kind,
    status: summary.status,
    tokenType: body.token_type,
    scope: body.scope,
    hasAccessToken: typeof body.access_token === 'string' && body.access_token.length > 0,
    hasRefreshToken: typeof body.refresh_token === 'string' && body.refresh_token.length > 0,
  };
}

describe('authorization requests', () => {
  it('keeps a malformed request on an error page without resolving a redirect target', async () => {
    const harness = createHarness();
    const result = await handleAuthorize(harness.context, new URL(`${PUBLIC_URL}/oauth/authorize?client_id=${CLIENT_ID}`), USER_ID);

    expect({ result: htmlSummary(result), clientLookups: vi.mocked(harness.database.getOAuthClient).mock.calls.length })
      .toMatchObject({ result: { kind: 'html', status: 400 }, clientLookups: 0 });
  });

  it('keeps an unregistered redirect URI on an error page', async () => {
    const harness = createHarness();
    const result = await handleAuthorize(
      harness.context,
      authorizationUrl({ redirect_uri: 'https://attacker.example/callback' }),
      USER_ID,
    );

    expect(htmlErrorSummary(result, 'Unregistered address')).toEqual({ kind: 'html', status: 400, includesExpectedText: true });
  });

  it.each([
    { reason: 'an unsupported response type', overrides: { response_type: 'token' }, error: 'unsupported_response_type' },
    { reason: 'a downgraded PKCE method', overrides: { code_challenge_method: 'plain' }, error: 'invalid_request' },
    { reason: 'a different resource', overrides: { resource: 'https://other.example/mcp' }, error: 'invalid_target' },
    { reason: 'an unsupported scope', overrides: { scope: 'admin' }, error: 'invalid_scope' },
  ])('redirects $reason only after the redirect URI is trusted', async ({ overrides, error }) => {
    const harness = createHarness();
    const result = await handleAuthorize(harness.context, authorizationUrl(overrides), USER_ID);

    expect(redirectSummary(result)).toEqual({
      originAndPath: REDIRECT_URI,
      error,
      state: STATE,
      issuer: PUBLIC_URL,
      hasCode: false,
    });
  });
});

describe('consent submissions', () => {
  it('rejects a form with no consent token', async () => {
    const harness = createHarness();
    const result = await handleConsent(harness.context, new URLSearchParams({ decision: 'approve' }), USER_ID);

    expect(htmlErrorSummary(result, 'without an approval token')).toEqual({ kind: 'html', status: 400, includesExpectedText: true });
  });

  it('rejects a missing or expired consent token', async () => {
    const harness = createHarness();
    const result = await handleConsent(harness.context, consentBody(), USER_ID);

    expect(htmlErrorSummary(result, 'approval expired')).toEqual({ kind: 'html', status: 400, includesExpectedText: true });
  });

  it('rejects consent submitted by a different account', async () => {
    const harness = createHarness({
      ephemeralValues: new Map([[`oauth:consent:${CONSENT_TOKEN}`, pendingConsent(OTHER_USER_ID)]]),
    });
    const result = await handleConsent(harness.context, consentBody(), USER_ID);

    expect(htmlErrorSummary(result, 'approval was not yours')).toEqual({ kind: 'html', status: 403, includesExpectedText: true });
  });

  it('redirects a declined request with state and issuer intact', async () => {
    const harness = createHarness({
      ephemeralValues: new Map([[`oauth:consent:${CONSENT_TOKEN}`, pendingConsent()]]),
    });
    const result = await handleConsent(harness.context, consentBody('decline'), USER_ID);

    expect(redirectSummary(result)).toEqual({
      originAndPath: REDIRECT_URI,
      error: 'access_denied',
      state: STATE,
      issuer: PUBLIC_URL,
      hasCode: false,
    });
  });

  it('issues a one-time authorization code after approval', async () => {
    const harness = createHarness({
      ephemeralValues: new Map([[`oauth:consent:${CONSENT_TOKEN}`, pendingConsent()]]),
    });
    const result = await handleConsent(harness.context, consentBody(), USER_ID);

    expect({ redirect: redirectSummary(result), storedValues: harness.ephemeralValues.size }).toEqual({
      redirect: {
        originAndPath: REDIRECT_URI,
        error: null,
        state: STATE,
        issuer: PUBLIC_URL,
        hasCode: true,
      },
      storedValues: 1,
    });
  });

  it('rejects replay of an already-approved consent token', async () => {
    const harness = createHarness({
      ephemeralValues: new Map([[`oauth:consent:${CONSENT_TOKEN}`, pendingConsent()]]),
    });
    await handleConsent(harness.context, consentBody(), USER_ID);
    const replay = await handleConsent(harness.context, consentBody(), USER_ID);

    expect({ result: htmlErrorSummary(replay, 'approval expired'), codesIssued: vi.mocked(harness.coordinator.setEphemeral).mock.calls.length })
      .toEqual({ result: { kind: 'html', status: 400, includesExpectedText: true }, codesIssued: 1 });
  });
});

describe('authorization code exchange', () => {
  it('rejects a code presented by the wrong client', async () => {
    const harness = authorizationCodeHarness();
    const result = await handleToken(harness.context, authorizationCodeBody({ client_id: 'different-client' }));

    expect({ response: jsonSummary(result), grants: vi.mocked(harness.database.authorizeOAuthGrant).mock.calls.length })
      .toMatchObject({ response: { status: 400, body: { error: 'invalid_grant' } }, grants: 0 });
  });

  it('rejects a redirect URI different from the authorization request', async () => {
    const harness = authorizationCodeHarness();
    const result = await handleToken(harness.context, authorizationCodeBody({ redirect_uri: 'https://client.example/other' }));

    expect({ response: jsonSummary(result), grants: vi.mocked(harness.database.authorizeOAuthGrant).mock.calls.length })
      .toMatchObject({ response: { status: 400, body: { error: 'invalid_grant' } }, grants: 0 });
  });

  it('rejects a PKCE verifier that does not match the challenge', async () => {
    const harness = authorizationCodeHarness();
    const result = await handleToken(harness.context, authorizationCodeBody({ code_verifier: 'wrong-verifier-that-is-at-least-forty-three-characters' }));

    expect({ response: jsonSummary(result), grants: vi.mocked(harness.database.authorizeOAuthGrant).mock.calls.length })
      .toMatchObject({ response: { status: 400, body: { error: 'invalid_grant' } }, grants: 0 });
  });

  it('rejects a resource different from the authorization request', async () => {
    const harness = authorizationCodeHarness();
    const result = await handleToken(harness.context, authorizationCodeBody({ resource: 'https://other.example/mcp' }));

    expect({ response: jsonSummary(result), grants: vi.mocked(harness.database.authorizeOAuthGrant).mock.calls.length })
      .toMatchObject({ response: { status: 400, body: { error: 'invalid_target' } }, grants: 0 });
  });

  it('issues a token pair for a valid authorization code', async () => {
    const harness = authorizationCodeHarness();
    const result = await handleToken(harness.context, authorizationCodeBody());

    expect({ response: tokenResponseSummary(result), grant: vi.mocked(harness.database.authorizeOAuthGrant).mock.calls[0]?.[0] }).toEqual({
      response: {
        kind: 'json',
        status: 200,
        tokenType: 'Bearer',
        scope: 'mcp',
        hasAccessToken: true,
        hasRefreshToken: true,
      },
      grant: {
        userId: USER_ID,
        clientId: CLIENT_ID,
        scopes: ['mcp'],
        resource: RESOURCE,
      },
    });
  });

  it('rejects replay of a successfully exchanged authorization code', async () => {
    const harness = authorizationCodeHarness();
    await handleToken(harness.context, authorizationCodeBody());
    const replay = await handleToken(harness.context, authorizationCodeBody());

    expect({ response: jsonSummary(replay), grants: vi.mocked(harness.database.authorizeOAuthGrant).mock.calls.length })
      .toMatchObject({ response: { status: 400, body: { error: 'invalid_grant' } }, grants: 1 });
  });
});

describe('refresh token exchange', () => {
  function refreshBody(): URLSearchParams {
    return new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'presented-refresh-token', client_id: CLIENT_ID });
  }

  it('returns the rotated token pair', async () => {
    const harness = createHarness({ refreshOutcome: { kind: 'rotated', tokens: TOKEN_PAIR } });
    const result = await handleToken(harness.context, refreshBody());

    expect({ response: tokenResponseSummary(result), rotations: vi.mocked(harness.database.rotateOAuthRefreshToken).mock.calls.length }).toEqual({
      response: {
        kind: 'json',
        status: 200,
        tokenType: 'Bearer',
        scope: 'mcp',
        hasAccessToken: true,
        hasRefreshToken: true,
      },
      rotations: 1,
    });
  });

  it('rejects an unknown refresh token', async () => {
    const harness = createHarness({ refreshOutcome: { kind: 'unknown' } });
    const result = await handleToken(harness.context, refreshBody());

    expect(jsonSummary(result)).toMatchObject({ kind: 'json', status: 400, body: { error: 'invalid_grant' } });
  });

  it('rejects a replayed refresh token', async () => {
    const harness = createHarness({ refreshOutcome: { kind: 'replayed', userId: USER_ID, clientId: CLIENT_ID } });
    const result = await handleToken(harness.context, refreshBody());

    expect(jsonSummary(result)).toMatchObject({ kind: 'json', status: 400, body: { error: 'invalid_grant' } });
  });
});

describe('token revocation', () => {
  it('returns the same empty 200 response for an unknown token', async () => {
    const harness = createHarness();
    const result = await handleRevoke(harness.context, new URLSearchParams({ token: 'unknown-token' }));

    expect({ response: jsonSummary(result), revocations: vi.mocked(harness.database.revokeOAuthToken).mock.calls.length })
      .toEqual({ response: { kind: 'json', status: 200, body: {} }, revocations: 1 });
  });

  it('returns an empty 200 response for a known token without disclosing it', async () => {
    const harness = createHarness();
    const result = await handleRevoke(harness.context, new URLSearchParams({ token: 'known-token' }));

    expect({ response: jsonSummary(result), revocations: vi.mocked(harness.database.revokeOAuthToken).mock.calls.length })
      .toEqual({ response: { kind: 'json', status: 200, body: {} }, revocations: 1 });
  });
});
