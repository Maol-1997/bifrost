import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { logger } from '../logger.js';
import { fetchClientMetadataDocument, isClientIdMetadataDocumentUrl, type RegisteredClient } from './clients.js';
import { renderConsentPage } from './consent-page.js';
import type { OAuthHttpResult, OAuthServerContext } from './context.js';
import { renderErrorPage } from './error-page.js';
import { OAuthError, type OAuthErrorCode } from './errors.js';
import { canonicalResource, issuerUrl, MCP_SCOPE } from './metadata.js';
import { isSupportedChallengeMethod } from './pkce.js';
import { isRedirectUriAllowed } from './redirect-uri.js';

/**
 * The authorization endpoint and the consent step behind it.
 *
 * The order of the checks here is the security design. Everything that runs
 * before `redirect_uri` has been matched against the client's registered list
 * reports failure on a page; everything after it reports failure by redirecting.
 * Getting that boundary wrong is what turns an authorization endpoint into an
 * open redirect.
 */

const CONSENT_TTL_SECONDS = 600;
const AUTHORIZATION_CODE_TTL_SECONDS = 60;
const TOKEN_BYTES = 32;
/** Clients may ask for this to signal they want a refresh token. Bifrost always issues one. */
const OFFLINE_ACCESS_SCOPE = 'offline_access';

const authorizeRequestSchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  response_type: z.string().default(''),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.string().optional(),
  state: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});

const pendingConsentSchema = z.object({
  clientId: z.string(),
  clientName: z.string(),
  userId: z.uuid(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  scopes: z.array(z.string()),
  resource: z.string(),
  state: z.string().optional(),
});

export const authorizationCodeSchema = z.object({
  clientId: z.string(),
  userId: z.uuid(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  scopes: z.array(z.string()),
  resource: z.string(),
});

type PendingConsent = z.infer<typeof pendingConsentSchema>;

export function authorizationCodeKey(code: string): string {
  return `oauth:code:${code}`;
}

export async function handleAuthorize(context: OAuthServerContext, url: URL, userId: string | undefined): Promise<OAuthHttpResult> {
  const parsed = authorizeRequestSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return errorPage('This request could not be read', 'It is missing client_id, redirect_uri or a PKCE code challenge, so there is nothing safe to act on.');
  }
  const request = parsed.data;

  // Before anything is resolved: resolving a metadata-document client is an
  // outbound fetch of a URL the caller chose, and that must only ever happen
  // on behalf of somebody who has already signed in.
  if (!userId) return { kind: 'sign-in-required', returnTo: `${url.pathname}${url.search}` };

  let client: RegisteredClient;
  try {
    client = await getOrFetchClient(context, request.client_id);
  } catch (error) {
    if (error instanceof OAuthError) return errorPage('This client could not be verified', error.description);
    throw error;
  }

  // The last check before redirects become safe. An unregistered address means
  // the request cannot be trusted to say where its own answer should go.
  if (!isRedirectUriAllowed(request.redirect_uri, client.redirectUris)) {
    logger.warn({ clientId: client.clientId }, 'Authorization request used an unregistered redirect address');
    return errorPage(
      'Unregistered address',
      `${client.clientName} asked Bifrost to send the response somewhere it has not registered. Nothing was authorized.`,
    );
  }

  const validated = validateAuthorizeRequest(context, request);
  if (validated.kind === 'rejected') return validated.result;

  const pending = pendingConsentFor({ client, request, userId, ...validated.granted });

  // Approving the same client again would ask the same question and get the
  // same answer, so a client that is already authorized reconnects silently.
  if (await context.database.hasOAuthGrant(userId, client.clientId, pending.resource)) {
    return issueAuthorizationCode(context, pending);
  }
  return askForConsent(context, client, pending);
}

type AuthorizeRequest = z.infer<typeof authorizeRequestSchema>;
type GrantedRequest = { resource: string; scopes: readonly string[] };
type ValidatedAuthorizeRequest =
  | { kind: 'granted'; granted: GrantedRequest }
  | { kind: 'rejected'; result: OAuthHttpResult };

/**
 * The protocol checks that run once `redirect_uri` is trusted, so every
 * rejection here travels back to the client as an error redirect.
 */
function validateAuthorizeRequest(context: OAuthServerContext, request: AuthorizeRequest): ValidatedAuthorizeRequest {
  const reject = (code: OAuthErrorCode, description: string): ValidatedAuthorizeRequest => ({
    kind: 'rejected',
    result: redirectFailure(context, { redirectUri: request.redirect_uri, code, description, state: request.state }),
  });

  if (request.response_type !== 'code') return reject('unsupported_response_type', 'Only the authorization code flow is supported');
  if (!isSupportedChallengeMethod(request.code_challenge_method)) return reject('invalid_request', 'code_challenge_method must be S256');

  const resource = normalizeResource(context, request.resource);
  if (!resource) return reject('invalid_target', 'The resource parameter does not name this MCP server');

  const scopes = parseScopes(request.scope);
  if (!scopes) return reject('invalid_scope', `The only supported scope is ${MCP_SCOPE}`);

  return { kind: 'granted', granted: { resource, scopes } };
}

function pendingConsentFor(input: { client: RegisteredClient; request: AuthorizeRequest; userId: string } & GrantedRequest): PendingConsent {
  return {
    clientId: input.client.clientId,
    clientName: input.client.clientName,
    userId: input.userId,
    redirectUri: input.request.redirect_uri,
    codeChallenge: input.request.code_challenge,
    scopes: [...input.scopes],
    resource: input.resource,
    ...(input.request.state === undefined ? {} : { state: input.request.state }),
  };
}

async function askForConsent(context: OAuthServerContext, client: RegisteredClient, pending: PendingConsent): Promise<OAuthHttpResult> {
  const user = await context.database.getUser(pending.userId);
  if (!user) return errorPage('Account not found', 'The signed-in account no longer exists. Sign in again and retry.');

  const consentToken = randomBytes(TOKEN_BYTES).toString('base64url');
  await context.coordinator.setEphemeral(`oauth:consent:${consentToken}`, JSON.stringify(pending), CONSENT_TTL_SECONDS);
  return {
    kind: 'html',
    status: 200,
    body: renderConsentPage({
      clientName: client.clientName,
      redirectUri: pending.redirectUri,
      redirectUris: client.redirectUris,
      scopes: pending.scopes,
      userEmail: user.email,
      consentToken,
    }),
  };
}

/**
 * The consent form's target.
 *
 * The consent token is minted server-side and spent atomically here, which is
 * what makes this immune to replay and to a forged submission: an attacker who
 * can make the browser POST still has no token, and a real token only works
 * once, for the user it was issued to.
 */
export async function handleConsent(context: OAuthServerContext, body: URLSearchParams, userId: string | undefined): Promise<OAuthHttpResult> {
  if (!userId) return errorPage('You are signed out', 'Sign in again and reconnect from your program.', 401);
  const consentToken = body.get('consent_token');
  if (!consentToken) return errorPage('This form could not be read', 'It arrived without an approval token.', 400);

  const raw = await context.coordinator.takeEphemeral(`oauth:consent:${consentToken}`);
  if (!raw) return errorPage('This approval expired', 'Approval requests are short-lived. Reconnect from your program to try again.', 400);
  const pending = pendingConsentSchema.parse(JSON.parse(raw));

  if (pending.userId !== userId) {
    logger.warn({ clientId: pending.clientId }, 'Consent submitted by a different account than the one it was issued to');
    return errorPage('This approval was not yours', 'It was issued to a different account. Nothing was authorized.', 403);
  }

  if (body.get('decision') !== 'approve') {
    return redirectFailure(context, { redirectUri: pending.redirectUri, code: 'access_denied', description: 'The user declined the request', state: pending.state });
  }
  logger.info({ clientId: pending.clientId, userId }, 'Client authorized by user');
  return issueAuthorizationCode(context, pending);
}

/**
 * Resolves a `client_id` to a client Bifrost will issue tokens to.
 *
 * A metadata-document client is re-fetched once its cached copy lapses, so a
 * client that rotates its redirect URIs takes effect without anyone re-registering.
 */
async function getOrFetchClient(context: OAuthServerContext, clientId: string): Promise<RegisteredClient> {
  const isMetadataDocument = isClientIdMetadataDocumentUrl(clientId);
  if (isMetadataDocument && !context.config.OAUTH_ENABLE_CLIENT_ID_METADATA_DOCUMENTS) {
    throw new OAuthError('invalid_client', 'This server is not accepting client metadata documents; register the client instead');
  }

  const stored = await context.database.getOAuthClient(clientId);
  const isCacheLive = stored?.metadataExpiresAt !== undefined && stored.metadataExpiresAt.getTime() > Date.now();
  if (stored && (stored.registrationKind === 'dynamic' || isCacheLive)) {
    return { clientId, clientName: stored.clientName, redirectUris: stored.redirectUris, registrationKind: stored.registrationKind };
  }
  if (!isMetadataDocument) throw new OAuthError('invalid_client', 'This client is not registered with Bifrost');

  const { client, cacheForMs } = await fetchClientMetadataDocument(clientId);
  await context.database.upsertOAuthClient({ ...client, metadataExpiresAt: new Date(Date.now() + cacheForMs) });
  logger.info({ clientId, registrationKind: client.registrationKind }, 'Resolved OAuth client');
  return client;
}

async function issueAuthorizationCode(context: OAuthServerContext, pending: PendingConsent): Promise<OAuthHttpResult> {
  const code = randomBytes(TOKEN_BYTES).toString('base64url');
  const payload: z.infer<typeof authorizationCodeSchema> = {
    clientId: pending.clientId,
    userId: pending.userId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    scopes: pending.scopes,
    resource: pending.resource,
  };
  // Short-lived and single-use: `takeEphemeral` is a get-and-delete, so a code
  // replayed against the token endpoint finds nothing.
  await context.coordinator.setEphemeral(authorizationCodeKey(code), JSON.stringify(payload), AUTHORIZATION_CODE_TTL_SECONDS);
  const location = new URL(pending.redirectUri);
  location.searchParams.set('code', code);
  if (pending.state !== undefined) location.searchParams.set('state', pending.state);
  // RFC 9207. Lets the client prove the response came from the server it asked,
  // which is what defeats a mix-up attack when it talks to more than one.
  location.searchParams.set('iss', issuerUrl(context.config.PUBLIC_URL));
  return { kind: 'redirect', location: location.toString() };
}

function redirectFailure(
  context: OAuthServerContext,
  failure: { redirectUri: string; code: OAuthErrorCode; description: string; state: string | undefined },
): OAuthHttpResult {
  const location = new URL(failure.redirectUri);
  location.searchParams.set('error', failure.code);
  location.searchParams.set('error_description', failure.description);
  if (failure.state !== undefined) location.searchParams.set('state', failure.state);
  location.searchParams.set('iss', issuerUrl(context.config.PUBLIC_URL));
  return { kind: 'redirect', location: location.toString() };
}

/**
 * Accepts either the fully specific resource or the bare issuer.
 *
 * The spec lists both forms as valid canonical URIs and tells clients to send
 * the most specific one they can, so a client naming the origin is being vague
 * rather than wrong. Either way the grant records the specific form, which is
 * what the audience check on `/mcp` compares against.
 */
function normalizeResource(context: OAuthServerContext, resource: string | undefined): string | undefined {
  const canonical = canonicalResource(context.config.PUBLIC_URL);
  if (resource === undefined) return canonical;
  const trimmed = resource.replace(/\/+$/, '');
  return trimmed === canonical || trimmed === issuerUrl(context.config.PUBLIC_URL) ? canonical : undefined;
}

/**
 * `offline_access` is accepted and dropped. Clients add it to ask for a refresh
 * token, which Bifrost issues unconditionally; rejecting the request over a
 * scope we always honour anyway would break refresh for the clients that ask
 * for it politely.
 */
function parseScopes(scope: string | undefined): string[] | undefined {
  const requested = (scope ?? '').split(' ').filter(Boolean).filter((entry) => entry !== OFFLINE_ACCESS_SCOPE);
  if (requested.length === 0) return [MCP_SCOPE];
  return requested.every((entry) => entry === MCP_SCOPE) ? [MCP_SCOPE] : undefined;
}

function errorPage(title: string, detail: string, status = 400): OAuthHttpResult {
  return { kind: 'html', status, body: renderErrorPage(title, detail) };
}
