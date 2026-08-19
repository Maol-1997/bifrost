import { randomBytes } from 'node:crypto';
import { logger } from '../logger.js';
import type { OAuthTokenPair } from '../db.js';
import { authorizationCodeKey, authorizationCodeSchema } from './authorize.js';
import { parseRegistrationRequest, registrationResponse, SUPPORTED_GRANT_TYPES } from './clients.js';
import type { OAuthHttpResult, OAuthServerContext } from './context.js';
import { OAuthError, type OAuthErrorCode } from './errors.js';
import { MCP_SCOPE } from './metadata.js';
import { verifyCodeChallenge } from './pkce.js';

/**
 * The token, registration and revocation endpoints.
 *
 * Everything here is machine-to-machine, so failures are OAuth error objects
 * rather than pages, and none of them ever quote the credential that failed.
 */

const CLIENT_ID_BYTES = 24;

export async function handleToken(context: OAuthServerContext, body: URLSearchParams): Promise<OAuthHttpResult> {
  try {
    const grantType = body.get('grant_type');
    if (grantType === 'authorization_code') return await exchangeAuthorizationCode(context, body);
    if (grantType === 'refresh_token') return await refreshTokens(context, body);
    throw new OAuthError('unsupported_grant_type', `Supported grants are ${SUPPORTED_GRANT_TYPES.join(' and ')}`);
  } catch (error) {
    if (error instanceof OAuthError) return tokenError(error.code, error.description);
    throw error;
  }
}

/**
 * Redeems an authorization code.
 *
 * The PKCE check is the one that matters: the code travelled through a browser
 * redirect and may have been observed, so possession of it alone is not enough.
 * Only the client that generated the verifier can finish the exchange.
 */
async function exchangeAuthorizationCode(context: OAuthServerContext, body: URLSearchParams): Promise<OAuthHttpResult> {
  const code = required(body, 'code');
  const clientId = required(body, 'client_id');
  const redirectUri = required(body, 'redirect_uri');
  const codeVerifier = required(body, 'code_verifier');

  const raw = await context.coordinator.takeEphemeral(authorizationCodeKey(code));
  if (!raw) throw new OAuthError('invalid_grant', 'This authorization code is expired, already used, or not valid');
  const authorization = authorizationCodeSchema.parse(JSON.parse(raw));

  // Each of these is its own attack being closed, so none of them collapse into
  // the others: a code redeemed by a different client, sent to a different
  // address, or redeemed without the original verifier.
  if (authorization.clientId !== clientId) throw new OAuthError('invalid_grant', 'This authorization code was not issued to this client');
  if (authorization.redirectUri !== redirectUri) throw new OAuthError('invalid_grant', 'The redirect_uri does not match the one used to authorize');
  if (!verifyCodeChallenge(codeVerifier, authorization.codeChallenge)) throw new OAuthError('invalid_grant', 'The PKCE code verifier does not match the challenge');

  // Optional here: the audience was already fixed when the code was issued, so
  // this only catches a client contradicting itself between the two requests.
  const requestedResource = body.get('resource')?.replace(/\/+$/, '');
  if (requestedResource !== undefined && requestedResource !== authorization.resource) {
    throw new OAuthError('invalid_target', 'The resource does not match the one this code was issued for');
  }

  const tokens = await context.database.authorizeOAuthGrant({
    userId: authorization.userId,
    clientId: authorization.clientId,
    scopes: authorization.scopes,
    resource: authorization.resource,
  });
  logger.info({ clientId, userId: authorization.userId }, 'Issued OAuth tokens from authorization code');
  return tokenResponse(tokens, authorization.scopes);
}

async function refreshTokens(context: OAuthServerContext, body: URLSearchParams): Promise<OAuthHttpResult> {
  const refreshToken = required(body, 'refresh_token');
  const clientId = required(body, 'client_id');
  const outcome = await context.database.rotateOAuthRefreshToken(refreshToken, clientId);

  if (outcome.kind === 'replayed') {
    // A refresh token is spent on first use, so a second presentation means the
    // value is in someone else's hands. There is no way to tell the thief from
    // the owner, so the grant is destroyed and the user reconnects deliberately.
    logger.error({ clientId: outcome.clientId, userId: outcome.userId }, 'Refresh token replay detected; grant revoked');
    throw new OAuthError('invalid_grant', 'This refresh token was already used. The client has been disconnected and must be authorized again');
  }
  if (outcome.kind === 'unknown') throw new OAuthError('invalid_grant', 'This refresh token is expired, revoked, or not valid for this client');

  logger.info({ clientId }, 'Rotated OAuth refresh token');
  return tokenResponse(outcome.tokens, [MCP_SCOPE]);
}

/** RFC 7591 dynamic registration. Deprecated by the spec, still what most clients reach for. */
export async function handleRegister(context: OAuthServerContext, payload: unknown): Promise<OAuthHttpResult> {
  try {
    const { clientName, redirectUris } = parseRegistrationRequest(payload);
    const client = {
      clientId: `bifrost-${randomBytes(CLIENT_ID_BYTES).toString('base64url')}`,
      clientName,
      redirectUris,
      registrationKind: 'dynamic' as const,
    };
    await context.database.upsertOAuthClient({ ...client, metadataExpiresAt: undefined });
    logger.info({ clientId: client.clientId, clientName }, 'Registered OAuth client dynamically');
    return { kind: 'json', status: 201, body: registrationResponse(client) };
  } catch (error) {
    if (error instanceof OAuthError) return { kind: 'json', status: 400, body: { error: error.code, error_description: error.description } };
    throw error;
  }
}

/**
 * RFC 7009 revocation. Always answers 200, including for a token it has never
 * seen: a distinguishable response would let a caller test whether a stolen
 * value is live.
 */
export async function handleRevoke(context: OAuthServerContext, body: URLSearchParams): Promise<OAuthHttpResult> {
  const token = body.get('token');
  if (token) await context.database.revokeOAuthToken(token);
  return { kind: 'json', status: 200, body: {} };
}

function tokenResponse(tokens: OAuthTokenPair, scopes: readonly string[]): OAuthHttpResult {
  return {
    kind: 'json',
    status: 200,
    body: {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.round((tokens.accessTokenExpiresAt.getTime() - Date.now()) / 1000)),
      refresh_token: tokens.refreshToken,
      scope: scopes.join(' '),
    },
  };
}

function tokenError(code: OAuthErrorCode, description: string): OAuthHttpResult {
  return { kind: 'json', status: code === 'invalid_client' ? 401 : 400, body: { error: code, error_description: description } };
}

function required(body: URLSearchParams, name: string): string {
  const value = body.get(name);
  if (!value) throw new OAuthError('invalid_request', `The ${name} parameter is required`);
  return value;
}
