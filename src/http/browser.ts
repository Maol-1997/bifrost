import type { Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { describeClient } from '../clients/describe.js';
import { errorSummary, logger } from '../logger.js';
import { PROVIDER_REGISTRY, SUPPORTED_APPS } from '../providers/registry.js';
import type { ProviderId } from '../providers/types.js';
import { knownToolNames, toolAvailability } from '../tools/preferences.js';
import { authenticateBrowser, clearSessionCookie } from './auth.js';
import type { AppContext, AppEnv } from './context.js';
import { callbackParameters } from './public.js';
import { limitRequestBody, readJsonBody } from './request-body.js';

const KNOWN_TOOL_NAMES = knownToolNames(PROVIDER_REGISTRY);
// A live session inside this window still works, but the UI warns that it will
// need renewal soon.
const RENEWAL_WINDOW_MS = 7 * 86_400_000;
const providerIdSchema = z.enum(SUPPORTED_APPS);
const clientActionSchema = z.object({
  kind: z.enum(['browser', 'agent']),
  id: z.uuid(),
  action: z.enum(['revoke', 'renew']),
});

export function createBrowserRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireBrowserIdentity);
  routes.use('*', limitRequestBody);

  routes.get('/api/app-connections.json', async (context) => context.json(await appConnections(context)));
  routes.get('/api/clients.json', async (context) => context.json(await clientList(context)));
  routes.get('/api/me.json', async (context) => {
    const user = await context.get('dependencies').database.getUser(context.get('browserIdentity').userId);
    if (!user) return context.json({ error: 'Your account could not be found' }, 404);
    return context.json(user);
  });
  routes.post('/api/clients/:kind/:id/:action', handleClientAction);
  routes.post('/auth/logout', logout);
  routes.get('/oauth/:providerId/start', startProviderAuthorization);
  routes.get('/oauth/:providerId/callback', finishProviderAuthorization);
  routes.post('/api/connections/:providerId/disconnect', disconnectProvider);
  routes.post('/api/connections/:providerId/preference', setProviderPreference);
  routes.post('/api/tools/:toolName/preference', setToolPreference);
  return routes;
}

async function requireBrowserIdentity(context: AppContext, next: Next): Promise<Response | undefined> {
  const identity = await authenticateBrowser(context);
  if (!identity) return context.json({ error: 'Authentication required' }, 401);
  context.set('browserIdentity', identity);
  await next();
}

async function logout(context: AppContext): Promise<Response> {
  const { database } = context.get('dependencies');
  await database.deleteSession(context.get('browserIdentity').token);
  clearSessionCookie(context);
  return context.redirect('/');
}

async function startProviderAuthorization(context: AppContext): Promise<Response> {
  const providerId = providerFromPath(context);
  if (!providerId) return context.json({ error: 'Not found' }, 404);
  const { oauth } = context.get('dependencies');
  const location = await oauth.startProviderAuthorization(context.get('browserIdentity').userId, providerId);
  return context.redirect(location);
}

async function finishProviderAuthorization(context: AppContext): Promise<Response> {
  const expectedProvider = providerFromPath(context);
  if (!expectedProvider) return context.json({ error: 'Not found' }, 404);
  const url = new URL(context.req.url);
  if (url.searchParams.has('error')) {
    return context.redirect(`/connection-result?result=cancelled&provider=${expectedProvider}`);
  }
  try {
    const parameters = callbackParameters(url);
    const result = await context.get('dependencies').oauth.finishProvider(parameters.code, parameters.state);
    if (result.providerId !== expectedProvider) throw new Error('OAuth provider callback mismatch');
    return context.redirect(`/connection-result?result=success&provider=${expectedProvider}`);
  } catch (error) {
    logger.warn(errorSummary(error), 'Provider OAuth callback failed');
    return context.redirect(`/connection-result?result=error&provider=${expectedProvider}`);
  }
}

async function disconnectProvider(context: AppContext): Promise<Response> {
  const providerId = providerFromPath(context);
  if (!providerId) return context.json({ error: 'Not found' }, 404);
  const { database } = context.get('dependencies');
  await database.deleteCredential(context.get('browserIdentity').userId, providerId);
  return context.json({ connected: false });
}

async function setProviderPreference(context: AppContext): Promise<Response> {
  const providerId = providerFromPath(context);
  if (!providerId) return context.json({ error: 'Not found' }, 404);
  const body = z.object({ isHidden: z.boolean() }).parse(await readJsonBody(context));
  const { database } = context.get('dependencies');
  await database.setProviderHidden(context.get('browserIdentity').userId, providerId, body.isHidden);
  return context.json({ isHidden: body.isHidden });
}

async function setToolPreference(context: AppContext): Promise<Response> {
  const toolName = context.req.param('toolName') ?? '';
  if (!KNOWN_TOOL_NAMES.has(toolName)) return context.json({ error: 'That tool does not exist' }, 404);
  const body = z.object({ isEnabled: z.boolean() }).parse(await readJsonBody(context));
  const { database } = context.get('dependencies');
  await database.setToolPreference(context.get('browserIdentity').userId, toolName, body.isEnabled);
  return context.json({ isEnabled: body.isEnabled });
}

async function handleClientAction(context: AppContext): Promise<Response> {
  const request = clientActionSchema.safeParse(context.req.param());
  if (!request.success) return context.json({ error: 'Not found' }, 404);
  const { database } = context.get('dependencies');
  const identity = context.get('browserIdentity');

  if (request.data.action === 'renew') {
    if (request.data.kind === 'agent') {
      return context.json({ error: 'This client keeps itself connected and does not need renewing' }, 400);
    }
    const renewedUntil = await database.renewSession(identity.userId, request.data.id);
    if (!renewedUntil) {
      return context.json({ error: 'That client has to sign in again before it can keep working' }, 409);
    }
    return context.json({ expiresAt: renewedUntil.toISOString() });
  }

  const isRevoked = request.data.kind === 'agent'
    ? await database.revokeOAuthGrant(identity.userId, request.data.id)
    : await database.revokeSession(identity.userId, request.data.id);
  if (!isRevoked) return context.json({ error: 'That client is no longer connected' }, 404);
  const wasCurrentClient = identity.kind === 'browser'
    && request.data.kind === 'browser'
    && request.data.id === identity.sessionId;
  if (wasCurrentClient) clearSessionCookie(context);
  return context.json({ revoked: true, wasCurrentClient });
}

function providerFromPath(context: AppContext): ProviderId | undefined {
  const parsed = providerIdSchema.safeParse(context.req.param('providerId'));
  return parsed.success ? parsed.data : undefined;
}

async function clientList(context: AppContext): Promise<{ clients: readonly object[] }> {
  const identity = context.get('browserIdentity');
  const { database } = context.get('dependencies');
  const [sessions, grants] = await Promise.all([
    database.listSessions(identity.userId),
    database.listOAuthGrants(identity.userId),
  ]);
  const clients = [
    ...sessions.map((session) => ({
      id: session.id,
      kind: 'browser' as const,
      ...describeClient(session.clientId, session.userAgent),
      isCurrent: identity.kind === 'browser' && session.id === identity.sessionId,
      firstConnectedAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      health: session.expiresAt.getTime() - Date.now() <= RENEWAL_WINDOW_MS ? 'needs-renewal' : 'healthy',
    })),
    ...grants.map((grant) => ({
      id: grant.id,
      kind: 'agent' as const,
      ...describeClient(grant.clientName, grant.userAgent),
      isCurrent: false,
      firstConnectedAt: grant.createdAt.toISOString(),
      lastUsedAt: grant.lastUsedAt.toISOString(),
      health: 'healthy' as const,
    })),
  ];
  return { clients: clients.sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt)) };
}

async function appConnections(context: AppContext): Promise<{ apps: readonly object[] }> {
  const identity = context.get('browserIdentity');
  const { config, database } = context.get('dependencies');
  const [connections, hidden, preferences] = await Promise.all([
    database.listConnections(identity.userId),
    database.hiddenProviders(identity.userId),
    database.toolPreferences(identity.userId),
  ]);
  const byProvider = new Map(connections.map((connection) => [connection.providerId, connection]));
  return {
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
  };
}
