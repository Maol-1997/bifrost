import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { describeClient } from './clients/describe.js';
import { loadConfig, type Config } from './config.js';
import { Coordinator } from './coordination.js';
import { Database } from './db.js';
import { errorSummary, logger } from './logger.js';
import { createHumanMcpHandler, toAuthInfo, type HumanIdentity } from './mcp.js';
import { EmailNotAllowedError, OAuthService } from './oauth.js';
import { handleAuthorize, handleConsent } from './oauth-server/authorize.js';
import type { OAuthHttpResult, OAuthServerContext } from './oauth-server/context.js';
import {
  authorizationServerMetadata, AUTHORIZATION_SERVER_PATH, AUTHORIZE_PATH, bearerChallenge, canonicalResource,
  CONSENT_PATH, MCP_SCOPE, protectedResourceMetadata, PROTECTED_RESOURCE_PATH, REGISTER_PATH, REVOKE_PATH, TOKEN_PATH,
} from './oauth-server/metadata.js';
import { handleRegister, handleRevoke, handleToken } from './oauth-server/token.js';
import { isAccessRestricted } from './security/access.js';
import { assertPrefixInvariant, mountProviders, PROVIDER_REGISTRY, SUPPORTED_APPS } from './providers/registry.js';
import type { ProviderId, ProviderMount } from './providers/types.js';
import { knownToolNames, toolAvailability } from './tools/preferences.js';
import { readAppHealth } from './status/upstream.js';
import { APP_ROUTES } from './lib/routes.js';

const KNOWN_TOOL_NAMES = knownToolNames(PROVIDER_REGISTRY);

const MAX_BODY_BYTES = 1_048_576;
const SESSION_COOKIE = 'bifrost_session';
const CLIENT_DIRECTORY = path.resolve(process.cwd(), 'dist/client');
// A session inside this window is what the UI calls "needs renewal": still
// working, but close enough to expiry that the browser will be signed out soon.
const RENEWAL_WINDOW_MS = 7 * 86_400_000;
const providerIdSchema = z.enum(['github', 'linear', 'slack']);
const clientKindSchema = z.enum(['browser', 'agent']);

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

async function main(): Promise<void> {
  const config = loadConfig();
  assertPrefixInvariant();
  const mounts = mountProviders();
  const database = new Database(config);
  const coordinator = new Coordinator();
  await coordinator.connect(config.REDIS_URL);
  if (!isAccessRestricted(config.accessPolicy)) {
    logger.warn({}, 'Sign-in is open to any verified Google account. Set ALLOWED_EMAIL_DOMAINS or ALLOWED_EMAILS to restrict it');
  }
  if (config.writeToolAllowlist.size === 0) {
    logger.warn({}, 'No deployment ceiling on write tools. Each user decides per tool in Integrations, starting off. Set WRITE_TOOL_ALLOWLIST to restrict which ones they may enable');
  }
  if (config.NODE_ENV === 'development' && config.BIFROST_DEV_USER_ID) {
    await database.ensureDevelopmentUser(config.BIFROST_DEV_USER_ID);
    logger.warn({ userId: config.BIFROST_DEV_USER_ID }, 'Development user header authentication is enabled');
  }
  const oauth = new OAuthService(config, database, coordinator);
  const mcpHandler = createHumanMcpHandler({ config, database, coordinator, oauth, mounts });
  const nodeMcpHandler = toNodeHandler(mcpHandler, { onerror: (error) => logger.error(errorSummary(error), 'Node MCP adapter error') });
  const server = createServer((request, response) => {
    void route({ request: request as AuthenticatedRequest, response, config, database, coordinator, oauth, mounts, nodeMcpHandler }).catch((error: unknown) => {
      logger.error(errorSummary(error), 'HTTP request failed');
      if (!response.headersSent) json(response, 500, { error: 'Internal server error' });
      else response.end();
    });
  });
  server.listen(config.PORT, '0.0.0.0', () => logger.info({ port: config.PORT }, 'Bifrost listening'));

  const shutdown = async (): Promise<void> => {
    server.close();
    await mcpHandler.close();
    await coordinator.close();
    await database.close();
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}

async function route(context: {
  request: AuthenticatedRequest;
  response: ServerResponse;
  config: Config;
  database: Database;
  coordinator: Coordinator;
  oauth: OAuthService;
  mounts: readonly ProviderMount[];
  nodeMcpHandler: ReturnType<typeof toNodeHandler>;
}): Promise<void> {
  const { request, response, config, database, coordinator, oauth, mounts, nodeMcpHandler } = context;
  setSecurityHeaders(response);
  const url = new URL(request.url ?? '/', config.PUBLIC_URL);
  if (!isAllowedHost(request, config)) return json(response, 403, { error: 'Host is not allowed' });

  if (url.pathname === '/healthz') return json(response, 200, { status: 'ok' });
  if (url.pathname.startsWith('/assets/')) return serveClientAsset(url.pathname, response);
  // Vite emits `public/` at the bundle root, not under /assets, and browsers
  // request the favicon before any authentication happens.
  if (url.pathname === '/favicon.svg') return serveClientAsset(url.pathname, response);
  if (url.pathname === '/api/status.json') return json(response, 200, providerStatus(mounts));
  // Unauthenticated on purpose. This is the vendors' own public uptime data,
  // identical for every visitor, and it is the one screen a user needs when
  // they cannot sign in. The 60s single-flight cache — not an auth check — is
  // what stops this from amplifying traffic onto the upstream status pages.
  if (url.pathname === '/api/provider-health.json') return json(response, 200, await readAppHealth());
  // Public: the sign-in screen has to state the real rule before you try to log
  // in. Only the domains are published — the individual allowlist names people.
  if (url.pathname === '/api/sign-in-policy.json') {
    return json(response, 200, {
      allowedDomains: [...config.accessPolicy.allowedEmailDomains],
      isRestricted: isAccessRestricted(config.accessPolicy),
    });
  }
  // Public by necessity: a client reads these before it has any credential, and
  // the whole point of the flow is that it can bootstrap itself from a bare URL.
  // RFC 9728 lets the document sit under the resource's path or at the root, and
  // clients probe in that order, so both are served.
  if (url.pathname === `${PROTECTED_RESOURCE_PATH}/mcp` || url.pathname === PROTECTED_RESOURCE_PATH) {
    return json(response, 200, protectedResourceMetadata(config.PUBLIC_URL));
  }
  if (url.pathname === AUTHORIZATION_SERVER_PATH) {
    return json(response, 200, authorizationServerMetadata(config.PUBLIC_URL, config.OAUTH_ENABLE_CLIENT_ID_METADATA_DOCUMENTS));
  }

  const oauthContext: OAuthServerContext = { config, database, coordinator };
  // Machine-to-machine and deliberately cookie-free: the caller is a program
  // holding a code or a refresh token, not a browser holding a session.
  if (url.pathname === REGISTER_PATH && request.method === 'POST') {
    return sendOAuthResult(response, await handleRegister(oauthContext, await readJsonBody(request)), oauth);
  }
  if (url.pathname === TOKEN_PATH && request.method === 'POST') {
    return sendOAuthResult(response, await handleToken(oauthContext, await readFormBody(request)), oauth);
  }
  if (url.pathname === REVOKE_PATH && request.method === 'POST') {
    return sendOAuthResult(response, await handleRevoke(oauthContext, await readFormBody(request)), oauth);
  }

  if (url.pathname === '/mcp/internal') return json(response, 501, { error: 'Service-to-service MCP endpoint is reserved but not implemented; use /mcp for human-attributed access' });
  if (url.pathname === '/auth/google/start') return redirect(response, await oauth.googleAuthorizationUrl('/'));
  if (url.pathname === '/auth/google/callback') return finishGoogle(url, response, oauth, config);

  if (url.pathname === '/mcp') {
    const agent = await authenticateAgent(request, database, config);
    // A caller that presented something gets told the credential is the problem,
    // which is the signal that sends it to its refresh token instead of back
    // through discovery and another round of consent.
    if (!agent) return mcpUnauthorized(response, config, headerValue(request, 'authorization') !== undefined);
    return handleMcp(request, response, agent, nodeMcpHandler, config);
  }

  if (isFrontendRoute(url.pathname)) return serveClientIndex(response);

  // The human's own screens, including the two OAuth steps a human drives. The
  // cookie is optional on `authorize`: arriving signed out is the normal first
  // visit, and the handler answers with a sign-in redirect rather than a 401.
  const identity = await authenticateBrowser(request, database, config);
  if (url.pathname === AUTHORIZE_PATH) {
    return sendOAuthResult(response, await handleAuthorize(oauthContext, url, identity?.userId), oauth);
  }
  if (url.pathname === CONSENT_PATH && request.method === 'POST') {
    return sendOAuthResult(response, await handleConsent(oauthContext, await readFormBody(request), identity?.userId), oauth);
  }
  if (!identity) return json(response, 401, { error: 'Authentication required' });

  if (url.pathname === '/api/app-connections.json') return appConnections(response, identity, database, config);
  if (url.pathname === '/api/clients.json') return json(response, 200, await clientList(identity, database));
  if (url.pathname === '/api/me.json') {
    const user = await database.getUser(identity.userId);
    // A live session whose user row is gone means the account was deleted out
    // from under it; that is a broken session, not an anonymous visitor.
    if (!user) return json(response, 404, { error: 'Your account could not be found' });
    return json(response, 200, user);
  }
  // The kind is in the path because a browser session and an OAuth grant are
  // different rows in different tables that happen to both be UUIDs. Guessing
  // which one an id means would be a way to act on the wrong record.
  const clientActionMatch = /^\/api\/clients\/(browser|agent)\/([0-9a-f-]{36})\/(revoke|renew)$/.exec(url.pathname);
  if (clientActionMatch && request.method === 'POST') {
    const [, kind, clientRecordId, action] = clientActionMatch;
    return clientAction(response, identity, database, config, {
      kind: clientKindSchema.parse(kind),
      id: z.uuid().parse(clientRecordId),
      action: z.enum(['revoke', 'renew']).parse(action),
    });
  }
  if (url.pathname === '/auth/logout' && request.method === 'POST') {
    await database.deleteSession(identity.token);
    response.setHeader('Set-Cookie', clearSessionCookie(config));
    return redirect(response, '/');
  }

  const oauthStartMatch = /^\/oauth\/(github|linear|slack)\/start$/.exec(url.pathname);
  if (oauthStartMatch) return redirect(response, await oauth.providerAuthorizationUrl(identity.userId, providerIdSchema.parse(oauthStartMatch[1])));
  const oauthCallbackMatch = /^\/oauth\/(github|linear|slack)\/callback$/.exec(url.pathname);
  if (oauthCallbackMatch) return finishProvider(url, response, oauth, providerIdSchema.parse(oauthCallbackMatch[1]));
  const disconnectMatch = /^\/api\/connections\/(github|linear|slack)\/disconnect$/.exec(url.pathname);
  if (disconnectMatch && request.method === 'POST') {
    await database.deleteCredential(identity.userId, providerIdSchema.parse(disconnectMatch[1]));
    return json(response, 200, { connected: false });
  }
  const preferenceMatch = /^\/api\/connections\/(github|linear|slack)\/preference$/.exec(url.pathname);
  if (preferenceMatch && request.method === 'POST') {
    const body = z.object({ isHidden: z.boolean() }).parse(await readJsonBody(request));
    await database.setProviderHidden(identity.userId, providerIdSchema.parse(preferenceMatch[1]), body.isHidden);
    return json(response, 200, { isHidden: body.isHidden });
  }
  const toolPreferenceMatch = /^\/api\/tools\/([a-z_]+)\/preference$/.exec(url.pathname);
  if (toolPreferenceMatch && request.method === 'POST') {
    const toolName = toolPreferenceMatch[1] ?? '';
    // Checked against the registry, not accepted as text: a stored preference
    // for a tool that does not exist is a row nobody can later explain.
    if (!KNOWN_TOOL_NAMES.has(toolName)) return json(response, 404, { error: 'That tool does not exist' });
    const body = z.object({ isEnabled: z.boolean() }).parse(await readJsonBody(request));
    await database.setToolPreference(identity.userId, toolName, body.isEnabled);
    return json(response, 200, { isEnabled: body.isEnabled });
  }
  return json(response, 404, { error: 'Not found' });
}

async function handleMcp(
  request: AuthenticatedRequest,
  response: ServerResponse,
  identity: HumanIdentity,
  handler: ReturnType<typeof toNodeHandler>,
  config: Config,
): Promise<void> {
  if (request.method !== 'POST') return json(response, 405, { error: 'MCP requires POST' });
  const startedAt = performance.now();
  const requestId = headerValue(request, 'x-request-id') ?? randomUUID();
  response.setHeader('X-Request-Id', requestId);
  let parsedBody: unknown;
  try {
    parsedBody = await readJsonBody(request);
  } catch {
    return json(response, 400, { error: 'Invalid JSON request body' });
  }
  parsedBody = attachRequestId(parsedBody, requestId);
  request.auth = toAuthInfo(identity);
  await handler(request as Parameters<typeof handler>[0], response, parsedBody);
  const details = inspectMcpRequest(parsedBody);
  const latencyMs = Math.round(performance.now() - startedAt);
  const fields = {
    userId: identity.userId, clientId: identity.clientId, jsonRpcMethod: details.method,
    ...(details.toolName ? { toolName: details.toolName } : {}), latencyMs, statusCode: response.statusCode, requestId,
  };
  if (latencyMs >= config.SLOW_REQUEST_MS) logger.warn(fields, 'Slow MCP request');
  else logger.info(fields, 'MCP request');
}

/**
 * The cookie path: a human in a browser.
 *
 * Cookies and bearer tokens resolve against different tables and mean different
 * things. Keeping them apart is why a leaked session cookie cannot be replayed
 * as an API credential, and why an access token cannot reach the account screens.
 */
async function authenticateBrowser(request: IncomingMessage, database: Database, config: Config): Promise<HumanIdentity | undefined> {
  const development = developmentIdentity(request, config);
  if (development) return development;
  const token = parseCookies(headerValue(request, 'cookie'))[SESSION_COOKIE];
  if (!token) return undefined;
  const resolved = await database.resolveSession(token, headerValue(request, 'user-agent'));
  if (!resolved) return undefined;
  return {
    kind: 'browser', id: resolved.sessionId, userId: resolved.userId, clientId: resolved.clientId,
    expiresAt: resolved.expiresAt, token, scopes: [MCP_SCOPE],
  };
}

/** The bearer path: an OAuth access token, which is the only thing `/mcp` accepts. */
async function authenticateAgent(request: IncomingMessage, database: Database, config: Config): Promise<HumanIdentity | undefined> {
  const development = developmentIdentity(request, config);
  if (development) return development;
  const token = headerValue(request, 'authorization')?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  if (!token) return undefined;
  const grant = await database.resolveOAuthAccessToken(token, headerValue(request, 'user-agent'));
  if (!grant) return undefined;
  // Audience binding. Every token Bifrost issues names this resource, so a
  // mismatch means the value came from somewhere else and is not ours to honour.
  if (grant.resource !== canonicalResource(config.PUBLIC_URL)) {
    logger.warn({ clientId: grant.clientId, resource: grant.resource }, 'Rejected an access token issued for a different resource');
    return undefined;
  }
  return {
    kind: 'agent', id: grant.grantId, userId: grant.userId, clientId: grant.clientId,
    expiresAt: grant.expiresAt, token, scopes: grant.scopes,
  };
}

function developmentIdentity(request: IncomingMessage, config: Config): HumanIdentity | undefined {
  const devUserId = headerValue(request, 'x-bifrost-dev-user');
  if (config.NODE_ENV !== 'development' || !config.BIFROST_DEV_USER_ID || devUserId !== config.BIFROST_DEV_USER_ID) return undefined;
  return {
    kind: 'browser', id: 'development-session', userId: devUserId,
    clientId: headerValue(request, 'x-bifrost-client-id') ?? 'development-client',
    expiresAt: new Date(Date.now() + 3_600_000), token: 'development-header-auth', scopes: [MCP_SCOPE],
  };
}

/**
 * The challenge that starts the whole flow. Without the header a client has no
 * way to find the authorization server and simply reports that it failed.
 */
function mcpUnauthorized(response: ServerResponse, config: Config, hadCredential: boolean): void {
  response.setHeader('WWW-Authenticate', bearerChallenge(config.PUBLIC_URL, hadCredential ? 'invalid_token' : undefined));
  json(response, 401, {
    error: hadCredential
      ? 'That credential is expired or not valid for this server'
      : 'Authorization required. This server speaks OAuth 2.1; your MCP client can set it up for you',
  });
}

async function sendOAuthResult(response: ServerResponse, result: OAuthHttpResult, oauth: OAuthService): Promise<void> {
  // OAuth responses carry codes and tokens, so none of them may be stored by an
  // intermediary — including the error bodies, which echo request parameters.
  response.setHeader('Cache-Control', 'no-store');
  if (result.kind === 'redirect') return redirect(response, result.location);
  if (result.kind === 'json') return json(response, result.status, result.body);
  if (result.kind === 'html') {
    response.statusCode = result.status;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(result.body);
    return;
  }
  return redirect(response, await oauth.googleAuthorizationUrl(result.returnTo));
}

/**
 * Everything that can currently reach Bifrost as this user: browser sessions and
 * OAuth grants, in one list, because from the user's side they are all just
 * "things connected to my account" and all of them are revocable here.
 */
async function clientList(identity: HumanIdentity, database: Database): Promise<{ clients: readonly object[] }> {
  const [sessions, grants] = await Promise.all([
    database.listSessions(identity.userId),
    database.listOAuthGrants(identity.userId),
  ]);
  const clients = [
    ...sessions.map((session) => ({
      id: session.id,
      kind: 'browser' as const,
      ...describeClient(session.clientId, session.userAgent),
      isCurrent: identity.kind === 'browser' && session.id === identity.id,
      firstConnectedAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      health: session.expiresAt.getTime() - Date.now() <= RENEWAL_WINDOW_MS ? 'needs-renewal' : 'healthy',
    })),
    ...grants.map((grant) => ({
      id: grant.id,
      kind: 'agent' as const,
      // The name the client registered under, which beats inferring one from a
      // user agent because the client actually declared it.
      ...describeClient(grant.clientName, grant.userAgent),
      isCurrent: false,
      firstConnectedAt: grant.createdAt.toISOString(),
      lastUsedAt: grant.lastUsedAt.toISOString(),
      // No expiry to report: a grant lives as long as it keeps being used.
      health: 'healthy' as const,
    })),
  ];
  return { clients: clients.sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt)) };
}

async function clientAction(
  response: ServerResponse,
  identity: HumanIdentity,
  database: Database,
  config: Config,
  request: { kind: 'browser' | 'agent'; id: string; action: 'revoke' | 'renew' },
): Promise<void> {
  if (request.action === 'renew') {
    // Only a browser session runs down a clock. An agent holds a refresh token
    // and replaces its own credential, so there is nothing here to extend.
    if (request.kind === 'agent') return json(response, 400, { error: 'This client keeps itself connected and does not need renewing' });
    const renewedUntil = await database.renewSession(identity.userId, request.id);
    if (!renewedUntil) return json(response, 409, { error: 'That client has to sign in again before it can keep working' });
    return json(response, 200, { expiresAt: renewedUntil.toISOString() });
  }

  const isRevoked = request.kind === 'agent'
    ? await database.revokeOAuthGrant(identity.userId, request.id)
    : await database.revokeSession(identity.userId, request.id);
  if (!isRevoked) return json(response, 404, { error: 'That client is no longer connected' });
  const wasCurrentClient = request.kind === 'browser' && request.id === identity.id;
  // Revoking the session you are browsing with is a sign-out; leaving the
  // cookie behind would just make every later request 401 on a dead token.
  if (wasCurrentClient) response.setHeader('Set-Cookie', clearSessionCookie(config));
  return json(response, 200, { revoked: true, wasCurrentClient });
}

async function finishGoogle(url: URL, response: ServerResponse, oauth: OAuthService, config: Config): Promise<void> {
  const parameters = callbackParameters(url);
  try {
    const result = await oauth.finishGoogle(parameters.code, parameters.state);
    response.setHeader('Set-Cookie', sessionCookie(result.sessionToken, config));
    // Back where sign-in interrupted them. For an agent connecting, that is the
    // authorization request it was midway through, so the flow resumes instead
    // of dumping the user on the home page with no idea what to do next.
    redirect(response, result.returnTo);
  } catch (error) {
    // A disallowed account is an expected outcome, not a server fault: send it
    // to the screen that explains it instead of a 500.
    if (error instanceof EmailNotAllowedError) return redirect(response, `${APP_ROUTES.signIn}?denied=true`);
    throw error;
  }
}

async function finishProvider(url: URL, response: ServerResponse, oauth: OAuthService, expectedProvider: ProviderId): Promise<void> {
  if (url.searchParams.has('error')) return redirect(response, `/connection-result?result=cancelled&provider=${expectedProvider}`);
  try {
    const parameters = callbackParameters(url);
    const result = await oauth.finishProvider(parameters.code, parameters.state);
    if (result.providerId !== expectedProvider) throw new Error('OAuth provider callback mismatch');
    redirect(response, `/connection-result?result=success&provider=${expectedProvider}`);
  } catch (error) {
    logger.warn(errorSummary(error), 'Provider OAuth callback failed');
    redirect(response, `/connection-result?result=error&provider=${expectedProvider}`);
  }
}

function callbackParameters(url: URL): { code: string; state: string } {
  const error = url.searchParams.get('error');
  if (error) throw new Error('OAuth authorization was denied or failed');
  return z.object({ code: z.string().min(1), state: z.string().min(1) }).parse({
    code: url.searchParams.get('code'), state: url.searchParams.get('state'),
  });
}

/**
 * Everything Integrations needs, including the real tool list.
 *
 * The tools ride along here rather than in their own endpoint because this is
 * already the per-user, per-provider view, and because a screen that draws
 * switches needs the connection state and the tool state to agree — fetching
 * them separately is how they end up disagreeing.
 */
async function appConnections(response: ServerResponse, identity: HumanIdentity, database: Database, config: Config): Promise<void> {
  const [connections, hidden, preferences] = await Promise.all([
    database.listConnections(identity.userId),
    database.hiddenProviders(identity.userId),
    database.toolPreferences(identity.userId),
  ]);
  const byProvider = new Map(connections.map((connection) => [connection.providerId, connection]));
  json(response, 200, {
    apps: SUPPORTED_APPS.map((providerId) => {
      const connection = byProvider.get(providerId);
      const provider = PROVIDER_REGISTRY.find((entry) => entry.id === providerId);
      return {
        providerId,
        isConnected: connection !== undefined,
        isHidden: hidden.has(providerId),
        needsReconnect: connection?.needsReconnect ?? false,
        tools: (provider?.tools ?? []).map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          mutability: tool.mutability,
          ...toolAvailability(tool, preferences, config.writeToolAllowlist),
        })),
        ...(connection ? { connectedAt: connection.connectedAt.toISOString() } : {}),
        ...(connection?.accountLabel ? { accountLabel: connection.accountLabel } : {}),
      };
    }),
  });
}

function providerStatus(mounts: readonly ProviderMount[]): { providers: readonly object[] } {
  return {
    providers: PROVIDER_REGISTRY.map((provider) => {
      const mount = mounts.find((entry) => entry.providerId === provider.id);
      return { id: provider.id, name: provider.displayName, isMounted: mount?.isMounted ?? false, toolCount: provider.tools.length, ...(mount?.error ? { error: mount.error } : {}) };
    }),
  };
}

function inspectMcpRequest(body: unknown): { method: string; toolName?: string } {
  const parsed = z.object({ method: z.string(), params: z.object({ name: z.string().optional() }).loose().optional() }).safeParse(body);
  if (!parsed.success) return { method: 'invalid' };
  return { method: parsed.data.method, ...(parsed.data.params?.name ? { toolName: parsed.data.params.name } : {}) };
}

function attachRequestId(body: unknown, requestId: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const requestBody = body as Record<string, unknown>;
  const params = requestBody.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return body;
  const parameterObject = params as Record<string, unknown>;
  const metadata = parameterObject._meta;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return body;
  return {
    ...requestBody,
    params: { ...parameterObject, _meta: { ...metadata, requestId } },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return JSON.parse(await readTextBody(request));
}

/** OAuth token, revocation and consent requests are all form-encoded, not JSON. */
async function readFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readTextBody(request));
}

async function readTextBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('Request body too large');
  }
  return body;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
}

const FRONTEND_ROUTES = new Set([
  '/',
  APP_ROUTES.signIn,
  APP_ROUTES.connectionResult,
  APP_ROUTES.integrations,
  APP_ROUTES.agents,
  APP_ROUTES.addAgent,
  APP_ROUTES.serviceStatus,
  APP_ROUTES.accountSecurity,
]);

function isFrontendRoute(pathname: string): boolean {
  return FRONTEND_ROUTES.has(pathname) || pathname.startsWith(`${APP_ROUTES.integrations}/`);
}

async function serveClientIndex(response: ServerResponse): Promise<void> {
  try {
    const body = await readFile(path.join(CLIENT_DIRECTORY, 'index.html'));
    sendFile(response, 200, 'text/html; charset=utf-8', body);
  } catch {
    json(response, 503, { error: 'Frontend bundle is unavailable. Run npm run build.' });
  }
}

async function serveClientAsset(pathname: string, response: ServerResponse): Promise<void> {
  const relativePath = pathname.slice(1);
  const assetPath = path.resolve(CLIENT_DIRECTORY, relativePath);
  if (!assetPath.startsWith(`${CLIENT_DIRECTORY}${path.sep}`)) return json(response, 404, { error: 'Not found' });
  try {
    const body = await readFile(assetPath);
    sendFile(response, 200, contentType(assetPath), body);
  } catch {
    json(response, 404, { error: 'Not found' });
  }
}

function contentType(assetPath: string): string {
  if (assetPath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (assetPath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (assetPath.endsWith('.svg')) return 'image/svg+xml';
  if (assetPath.endsWith('.png')) return 'image/png';
  if (assetPath.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

function sendFile(response: ServerResponse, status: number, contentTypeValue: string, body: Buffer): void {
  response.statusCode = status;
  response.setHeader('Content-Type', contentTypeValue);
  response.setHeader('Cache-Control', contentTypeValue.startsWith('text/html') ? 'no-cache' : 'public, max-age=31536000, immutable');
  response.end(body);
}

function isAllowedHost(request: IncomingMessage, config: Config): boolean {
  const host = headerValue(request, 'host')?.split(':')[0];
  const publicHost = new URL(config.PUBLIC_URL).hostname;
  return host === publicHost || host === 'localhost' || host === '127.0.0.1';
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseCookies(value?: string): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(value.split(';').map((part) => part.trim().split('=', 2)).filter((pair) => pair.length === 2) as Array<[string, string]>);
}

function sessionCookie(token: string, config: Config): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${config.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

function clearSessionCookie(config: Config): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${config.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 302;
  response.setHeader('Location', location);
  response.end();
}

await main();
