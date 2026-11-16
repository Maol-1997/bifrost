import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrationEnvironment } from './environment.js';
import { createIntegrationHarness, type IntegrationHarness } from './harness.js';

const REDIRECT_URI = 'http://127.0.0.1/callback';
const RESOURCE = 'https://bifrost.integration.test/mcp';

let harness: IntegrationHarness;

beforeAll(async () => {
  harness = await createIntegrationHarness({ environment: integrationEnvironment() });
});

afterAll(async () => {
  await harness.close();
});

type TokenResponse = { access_token: string; refresh_token: string; token_type: string; expires_in: number };

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

async function registerClient(): Promise<string> {
  const response = await harness.request('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Grant flow test',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/** Authorize, approve consent in the browser and return the code from the redirect. */
async function authorize(clientId: string, cookie: string, verifier: string): Promise<string> {
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: 'mcp',
    state: 'state-1',
  });
  const consentPage = await harness.request(`/oauth/authorize?${query.toString()}`, { headers: { Cookie: cookie } });
  expect(consentPage.status).toBe(200);
  const consentToken = /name="consent_token" value="([^"]+)"/.exec(await consentPage.text())?.[1];
  expect(consentToken).toBeDefined();

  const approved = await harness.request('/oauth/consent', {
    ...form({ consent_token: consentToken!, decision: 'approve' }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
  });
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get('location')!);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
  expect(location.searchParams.get('state')).toBe('state-1');
  return location.searchParams.get('code')!;
}

async function token(fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await harness.request('/oauth/token', form(fields));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function signedInClient() {
  const clientId = await registerClient();
  const userId = await harness.createUser();
  const cookie = await harness.createSessionCookie(userId);
  const verifier = randomBytes(32).toString('base64url');
  const code = await authorize(clientId, cookie, verifier);
  return { clientId, verifier, code };
}

function exchange(client: { clientId: string; verifier: string; code: string }) {
  return token({
    grant_type: 'authorization_code',
    code: client.code,
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    code_verifier: client.verifier,
    resource: RESOURCE,
  });
}

function refresh(clientId: string, refreshToken: string) {
  return token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
}

describe('OAuth grants against real Postgres and Redis', () => {
  it('issues tokens for a code once, and only with the right verifier', async () => {
    const client = await signedInClient();

    const wrongVerifier = await exchange({ ...client, verifier: randomBytes(32).toString('base64url') });
    expect(wrongVerifier.status).toBe(400);
    expect(wrongVerifier.body.error).toBe('invalid_grant');

    // The failed attempt consumed the code, so the right verifier is too late as well.
    const afterFailure = await exchange(client);
    expect(afterFailure.body.error).toBe('invalid_grant');
  });

  it('runs authorize, consent and the token exchange to a working bearer token', async () => {
    const client = await signedInClient();

    const issued = await exchange(client);
    expect(issued.status).toBe(200);
    const tokens = issued.body as TokenResponse;
    expect(tokens.token_type).toBe('Bearer');
    expect((await harness.listTools(tokens.access_token)).status).toBe(200);

    const reused = await exchange(client);
    expect(reused.body.error).toBe('invalid_grant');
  });

  it('rotates the refresh token on every use', async () => {
    const client = await signedInClient();
    const first = (await exchange(client)).body as TokenResponse;

    const rotated = await refresh(client.clientId, first.refresh_token);

    expect(rotated.status).toBe(200);
    const second = rotated.body as TokenResponse;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    expect((await harness.listTools(second.access_token)).status).toBe(200);
  });

  it('destroys the whole grant when a spent refresh token is replayed', async () => {
    const client = await signedInClient();
    const first = (await exchange(client)).body as TokenResponse;
    const second = (await refresh(client.clientId, first.refresh_token)).body as TokenResponse;

    const replay = await refresh(client.clientId, first.refresh_token);

    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    // Every credential from that grant is gone, including the ones issued after the leak.
    expect((await harness.listTools(second.access_token)).status).toBe(401);
    expect((await refresh(client.clientId, second.refresh_token)).body.error).toBe('invalid_grant');
  });

  it('refuses a refresh token presented by another client', async () => {
    const client = await signedInClient();
    const otherClientId = await registerClient();
    const first = (await exchange(client)).body as TokenResponse;

    const stolen = await refresh(otherClientId, first.refresh_token);

    expect(stolen.body.error).toBe('invalid_grant');
  });
});
