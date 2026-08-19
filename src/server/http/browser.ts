import { zValidator, type Hook } from '@hono/zod-validator';
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
import { limitRequestBody } from './request-body.js';

const KNOWN_TOOL_NAMES = knownToolNames(PROVIDER_REGISTRY);
// A live session inside this window still works, but the UI warns that it will
// need renewal soon.
const RENEWAL_WINDOW_MS = 7 * 86_400_000;
const providerPathSchema = z.object({ providerId: z.enum(SUPPORTED_APPS) });
const clientActionSchema = z.object({
  kind: z.enum(['browser', 'agent']),
  id: z.uuid(),
  action: z.enum(['revoke', 'renew']),
});
const providerPreferenceSchema = z.object({ isHidden: z.boolean() });
const toolPathSchema = z.object({
  toolName: z.string().refine((toolName) => KNOWN_TOOL_NAMES.has(toolName)),
});
const toolPreferenceSchema = z.object({ isEnabled: z.boolean() });

const validateProviderPath = validateRequest('param', providerPathSchema, { status: 404, message: 'Not found' });
const validateClientAction = validateRequest('param', clientActionSchema, { status: 404, message: 'Not found' });
const validateToolPath = validateRequest('param', toolPathSchema, { status: 404, message: 'That tool does not exist' });
const validateProviderPreference = validateRequest('json', providerPreferenceSchema, { status: 400, message: 'Invalid request body' });
const validateToolPreference = validateRequest('json', toolPreferenceSchema, { status: 400, message: 'Invalid request body' });

export function createBrowserRoutes() {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireBrowserIdentity);
  routes.use('*', limitRequestBody);

  return routes
    .get('/api/app-connections.json', async (context) => context.json(await appConnections(context)))
    .get('/api/clients.json', async (context) => context.json(await clientList(context)))
    .get('/api/me.json', async (context) => {
      const user = await context.get('dependencies').database.getUser(context.get('browserIdentity').userId);
      if (!user) return context.json({ error: 'Your account could not be found' }, 404);
      return context.json(user);
    })
    .post('/api/clients/:kind/:id/:action', validateClientAction, (context) => (
      handleClientAction(context, context.req.valid('param'))
    ))
    .post('/auth/logout', logout)
    .get('/oauth/:providerId/start', validateProviderPath, (context) => (
      startProviderAuthorization(context, context.req.valid('param').providerId)
    ))
    .get('/oauth/:providerId/callback', validateProviderPath, (context) => (
      finishProviderAuthorization(context, context.req.valid('param').providerId)
    ))
    .post('/api/connections/:providerId/disconnect', validateProviderPath, (context) => (
      disconnectProvider(context, context.req.valid('param').providerId)
    ))
    .post(
      '/api/connections/:providerId/preference',
      validateProviderPath,
      validateProviderPreference,
      (context) => setProviderPreference(
        context,
        context.req.valid('param').providerId,
        context.req.valid('json'),
      ),
    )
    .post(
      '/api/tools/:toolName/preference',
      validateToolPath,
      validateToolPreference,
      (context) => setToolPreference(
        context,
        context.req.valid('param').toolName,
        context.req.valid('json'),
      ),
    );
}

function validateRequest<Schema extends z.ZodType, Target extends 'json' | 'param'>(
  target: Target,
  schema: Schema,
  error: { status: 400 | 404; message: string },
) {
  type RequestHook = Hook<z.infer<Schema>, AppEnv, string, Target, { error: string }, Schema>;
  const reject = (result: Parameters<RequestHook>[0], context: Parameters<RequestHook>[1]) => {
    if (!result.success) return context.json({ error: error.message }, error.status);
  };
  return zValidator<Schema, Target, AppEnv, string, typeof reject>(target, schema, reject);
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

async function startProviderAuthorization(context: AppContext, providerId: ProviderId): Promise<Response> {
  const { oauth } = context.get('dependencies');
  const location = await oauth.startProviderAuthorization(context.get('browserIdentity').userId, providerId);
  return context.redirect(location);
}

async function finishProviderAuthorization(context: AppContext, expectedProvider: ProviderId): Promise<Response> {
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

async function disconnectProvider(context: AppContext, providerId: ProviderId) {
  const { database } = context.get('dependencies');
  await database.deleteCredential(context.get('browserIdentity').userId, providerId);
  return context.json({ connected: false });
}

async function setProviderPreference(
  context: AppContext,
  providerId: ProviderId,
  preference: z.infer<typeof providerPreferenceSchema>,
) {
  const { database } = context.get('dependencies');
  await database.setProviderHidden(context.get('browserIdentity').userId, providerId, preference.isHidden);
  return context.json(preference);
}

async function setToolPreference(
  context: AppContext,
  toolName: string,
  preference: z.infer<typeof toolPreferenceSchema>,
) {
  const { database } = context.get('dependencies');
  await database.setToolPreference(context.get('browserIdentity').userId, toolName, preference.isEnabled);
  return context.json(preference);
}

async function handleClientAction(
  context: AppContext,
  request: z.infer<typeof clientActionSchema>,
) {
  const { database } = context.get('dependencies');
  const identity = context.get('browserIdentity');

  if (request.action === 'renew') {
    if (request.kind === 'agent') {
      return context.json({ error: 'This client keeps itself connected and does not need renewing' }, 400);
    }
    const renewedUntil = await database.renewSession(identity.userId, request.id);
    if (!renewedUntil) {
      return context.json({ error: 'That client has to sign in again before it can keep working' }, 409);
    }
    return context.json({ expiresAt: renewedUntil.toISOString() });
  }

  const isRevoked = request.kind === 'agent'
    ? await database.revokeOAuthGrant(identity.userId, request.id)
    : await database.revokeSession(identity.userId, request.id);
  if (!isRevoked) return context.json({ error: 'That client is no longer connected' }, 404);
  const wasCurrentClient = identity.kind === 'browser'
    && request.kind === 'browser'
    && request.id === identity.sessionId;
  if (wasCurrentClient) clearSessionCookie(context);
  return context.json({ revoked: true, wasCurrentClient });
}

async function clientList(context: AppContext) {
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
      health: session.expiresAt.getTime() - Date.now() <= RENEWAL_WINDOW_MS
        ? 'needs-renewal' as const
        : 'healthy' as const,
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

async function appConnections(context: AppContext) {
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
