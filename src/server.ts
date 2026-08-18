import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { loadConfig, type Config } from './config.js';
import { Coordinator } from './coordination.js';
import { Database } from './db.js';
import { errorSummary, logger } from './logger.js';
import { createHumanMcpHandler, toAuthInfo, type HumanIdentity } from './mcp.js';
import { OAuthService } from './oauth.js';
import { assertPrefixInvariant, mountProviders, PROVIDER_REGISTRY, SUPPORTED_APPS } from './providers/registry.js';
import type { ProviderId, ProviderMount } from './providers/types.js';

const MAX_BODY_BYTES = 1_048_576;
const SESSION_COOKIE = 'bifrost_session';
const providerIdSchema = z.enum(['github', 'linear', 'slack']);

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

async function main(): Promise<void> {
  const config = loadConfig();
  assertPrefixInvariant();
  const mounts = mountProviders();
  const database = new Database(config);
  const coordinator = new Coordinator();
  await coordinator.connect(config.REDIS_URL);
  if (config.NODE_ENV === 'development' && config.BIFROST_DEV_USER_ID) {
    await database.ensureDevelopmentUser(config.BIFROST_DEV_USER_ID);
    logger.warn({ userId: config.BIFROST_DEV_USER_ID }, 'Development user header authentication is enabled');
  }
  const oauth = new OAuthService(config, database, coordinator);
  const mcpHandler = createHumanMcpHandler({ config, database, coordinator, oauth, mounts });
  const nodeMcpHandler = toNodeHandler(mcpHandler, { onerror: (error) => logger.error(errorSummary(error), 'Node MCP adapter error') });
  const server = createServer((request, response) => {
    void route({ request: request as AuthenticatedRequest, response, config, database, oauth, mounts, nodeMcpHandler }).catch((error: unknown) => {
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
  oauth: OAuthService;
  mounts: readonly ProviderMount[];
  nodeMcpHandler: ReturnType<typeof toNodeHandler>;
}): Promise<void> {
  const { request, response, config, database, oauth, mounts, nodeMcpHandler } = context;
  setSecurityHeaders(response);
  const url = new URL(request.url ?? '/', config.PUBLIC_URL);
  if (!isAllowedHost(request, config)) return json(response, 403, { error: 'Host is not allowed' });

  if (url.pathname === '/healthz') return json(response, 200, { status: 'ok' });
  if (url.pathname === '/api/status.json') return json(response, 200, providerStatus(mounts));
  if (url.pathname === '/mcp/internal') return json(response, 501, { error: 'Service-to-service MCP endpoint is reserved but not implemented; use /mcp for human-attributed access' });
  if (url.pathname === '/auth/google/start') return redirect(response, await oauth.googleAuthorizationUrl());
  if (url.pathname === '/auth/google/callback') return finishGoogle(url, response, oauth, config);

  const identity = await authenticate(request, database, config);
  if (url.pathname === '/mcp') {
    if (!identity) return json(response, 401, { error: 'Authentication required. Sign in with Google at /auth/google/start' });
    return handleMcp(request, response, identity, nodeMcpHandler, config);
  }
  if (url.pathname === '/') return html(response, 200, await renderPage(identity, mounts, database));
  if (!identity) return json(response, 401, { error: 'Authentication required' });

  if (url.pathname === '/api/app-connections.json') return appConnections(response, identity, database);
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

async function authenticate(request: IncomingMessage, database: Database, config: Config): Promise<HumanIdentity | undefined> {
  const devUserId = headerValue(request, 'x-bifrost-dev-user');
  if (config.NODE_ENV === 'development' && config.BIFROST_DEV_USER_ID && devUserId === config.BIFROST_DEV_USER_ID) {
    return { userId: devUserId, clientId: headerValue(request, 'x-bifrost-client-id') ?? 'development-client', expiresAt: new Date(Date.now() + 3_600_000), token: 'development-header-auth' };
  }
  const bearer = headerValue(request, 'authorization')?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  const cookie = parseCookies(headerValue(request, 'cookie'))[SESSION_COOKIE];
  const token = bearer ?? cookie;
  if (!token) return undefined;
  const resolved = await database.resolveSession(token);
  return resolved ? { ...resolved, token } : undefined;
}

async function finishGoogle(url: URL, response: ServerResponse, oauth: OAuthService, config: Config): Promise<void> {
  const parameters = callbackParameters(url);
  const result = await oauth.finishGoogle(parameters.code, parameters.state);
  response.setHeader('Set-Cookie', sessionCookie(result.sessionToken, config));
  redirect(response, '/');
}

async function finishProvider(url: URL, response: ServerResponse, oauth: OAuthService, expectedProvider: ProviderId): Promise<void> {
  const parameters = callbackParameters(url);
  const result = await oauth.finishProvider(parameters.code, parameters.state);
  if (result.providerId !== expectedProvider) throw new Error('OAuth provider callback mismatch');
  redirect(response, '/');
}

function callbackParameters(url: URL): { code: string; state: string } {
  const error = url.searchParams.get('error');
  if (error) throw new Error('OAuth authorization was denied or failed');
  return z.object({ code: z.string().min(1), state: z.string().min(1) }).parse({
    code: url.searchParams.get('code'), state: url.searchParams.get('state'),
  });
}

async function appConnections(response: ServerResponse, identity: HumanIdentity, database: Database): Promise<void> {
  const connected = await database.connectedProviders(identity.userId);
  const hidden = await database.hiddenProviders(identity.userId);
  json(response, 200, {
    apps: SUPPORTED_APPS.map((providerId) => ({ providerId, isConnected: connected.has(providerId), isHidden: hidden.has(providerId) })),
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
  let body = '';
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('Request body too large');
  }
  return JSON.parse(body);
}

async function renderPage(identity: HumanIdentity | undefined, mounts: readonly ProviderMount[], database: Database): Promise<string> {
  const connected = identity ? await database.connectedProviders(identity.userId) : new Set<ProviderId>();
  const hidden = identity ? await database.hiddenProviders(identity.userId) : new Set<ProviderId>();
  const providers = PROVIDER_REGISTRY.map((provider) => {
    const mounted = mounts.find((mount) => mount.providerId === provider.id)?.isMounted ?? false;
    const connection = connected.has(provider.id) ? `connected${hidden.has(provider.id) ? ', hidden from MCP' : ''}` : 'not connected';
    return `<li><strong>${provider.displayName}</strong>: ${mounted ? 'mounted' : 'unavailable'}${identity ? ` · ${connection} · <a href="/oauth/${provider.id}/start">${connected.has(provider.id) ? 'Reconnect' : 'Connect'}</a>` : ''}</li>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bifrost</title><style>body{font:16px system-ui;max-width:720px;margin:3rem auto;padding:0 1rem;line-height:1.5}li{margin:.75rem 0}</style></head><body><h1>Bifrost</h1><p>Unified internal MCP gateway.</p>${identity ? '<p>Signed in. Connection state: <a href="/api/app-connections.json">JSON</a>.</p>' : '<p><a href="/auth/google/start">Sign in with Google</a></p>'}<ul>${providers}</ul><p><a href="/api/status.json">Provider status JSON</a></p></body></html>`;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
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

function html(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(body);
}

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 302;
  response.setHeader('Location', location);
  response.end();
}

await main();
