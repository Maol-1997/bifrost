import { zValidator, type Hook } from '@hono/zod-validator';
import type { Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { describeClient } from '../clients/describe.js';
import { errorSummary, logger } from '../logger.js';
import { PROVIDER_REGISTRY, SUPPORTED_APPS } from '../providers/registry.js';
import type { ProviderId } from '../providers/types.js';
import { effectivePolicyState, isToolEnabled, toolPolicyReviewsMatchCurrentDefinitions, TOOL_POLICY_STATES } from '../tools/catalog.js';
import { discoverConnectedTools, discoverProviderTools, discoverProviderToolsFresh, invalidateProviderToolDiscovery } from '../tools/discovery.js';
import { aggregateToolCacheHints, toolCacheHintFromError } from '../tools/discovery-cache.js';
import { isAdministrator } from '../security/access.js';
import { authenticateBrowser, clearSessionCookie } from './auth.js';
import type { AppContext, AppEnv } from './context.js';
import { callbackParameters } from './public.js';
import { limitRequestBody } from './request-body.js';

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
  toolName: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
});
const toolPreferenceSchema = z.object({ isEnabled: z.boolean() });
const toolPolicySchema = z.object({
  state: z.enum(TOOL_POLICY_STATES),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const toolPolicyBatchSchema = z.object({
  tools: z.array(toolPolicySchema.extend(toolPathSchema.shape)).min(1),
});

const validateProviderPath = validateRequest('param', providerPathSchema, { status: 404, message: 'Not found' });
const validateClientAction = validateRequest('param', clientActionSchema, { status: 404, message: 'Not found' });
const validateToolPath = validateRequest('param', toolPathSchema, { status: 404, message: 'That tool does not exist' });
const validateProviderPreference = validateRequest('json', providerPreferenceSchema, { status: 400, message: 'Invalid request body' });
const validateToolPreference = validateRequest('json', toolPreferenceSchema, { status: 400, message: 'Invalid request body' });
const validateToolPolicyBatch = validateRequest('json', toolPolicyBatchSchema, { status: 400, message: 'Invalid request body' });

export function createBrowserRoutes() {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireBrowserIdentity);
  routes.use('*', limitRequestBody);
  routes.use('/api/admin/*', requireAdministrator);

  return routes
    .get('/api/app-connections.json', async (context) => context.json(await appConnections(context)))
    .get('/api/clients.json', async (context) => context.json(await clientList(context)))
    .get('/api/me.json', async (context) => {
      const user = await context.get('dependencies').database.getUser(context.get('browserIdentity').userId);
      if (!user) return context.json({ error: 'Your account could not be found' }, 404);
      return context.json({ ...user, isAdmin: isAdministrator(user.email, context.get('dependencies').config.adminEmails) });
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
    )
    .get(
      '/api/admin/providers/:providerId/tools.json',
      validateProviderPath,
      (context) => adminProviderToolList(
        context,
        context.req.valid('param').providerId,
        discoverProviderTools,
      ),
    )
    .post(
      '/api/admin/providers/:providerId/tools/refresh',
      validateProviderPath,
      (context) => adminProviderToolList(
        context,
        context.req.valid('param').providerId,
        discoverProviderToolsFresh,
      ),
    )
    .post(
      '/api/admin/tools/:providerId/policies',
      validateProviderPath,
      validateToolPolicyBatch,
      (context) => setDeploymentToolPolicies(
        context,
        context.req.valid('param').providerId,
        context.req.valid('json').tools,
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

async function requireAdministrator(context: AppContext, next: Next): Promise<Response | undefined> {
  const { config, database } = context.get('dependencies');
  const user = await database.getUser(context.get('browserIdentity').userId);
  if (!user || !isAdministrator(user.email, config.adminEmails)) {
    return context.json({ error: 'Administrator access required' }, 403);
  }
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
    invalidateProviderToolDiscovery(result.userId, result.providerId);
    return context.redirect(`/connection-result?result=success&provider=${expectedProvider}`);
  } catch (error) {
    logger.warn(errorSummary(error), 'Provider OAuth callback failed');
    return context.redirect(`/connection-result?result=error&provider=${expectedProvider}`);
  }
}

async function disconnectProvider(context: AppContext, providerId: ProviderId) {
  const { database } = context.get('dependencies');
  const userId = context.get('browserIdentity').userId;
  await database.deleteCredential(userId, providerId);
  invalidateProviderToolDiscovery(userId, providerId);
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
  const identity = context.get('browserIdentity');
  const { database, mounts, oauth } = context.get('dependencies');
  const [connectedProviders, policies] = await Promise.all([
    database.connectedProviders(identity.userId),
    database.toolPolicies(),
  ]);
  const discovery = await discoverConnectedTools({
    userId: identity.userId,
    connectedProviders,
    hiddenProviders: new Set(),
    oauth,
    mounts,
    signal: context.req.raw.signal,
  });
  const tool = discovery.tools.find((entry) => entry.name === toolName);
  if (!tool) {
    return context.json({ error: 'That tool does not exist' }, 404);
  }
  const state = effectivePolicyState(tool, policies);
  if (state === 'blocked') return context.json({ error: 'That tool does not exist' }, 404);
  const defaultEnabled = state === 'allowed_default_on';
  if (preference.isEnabled === defaultEnabled) {
    await database.clearToolPreference(identity.userId, toolName);
  } else {
    await database.setToolPreference(identity.userId, toolName, preference.isEnabled);
  }
  return context.json(preference);
}

type ProviderToolDiscoverer = typeof discoverProviderTools;

async function adminProviderToolList(
  context: AppContext,
  providerId: ProviderId,
  discover: ProviderToolDiscoverer,
) {
  const identity = context.get('browserIdentity');
  const { database, mounts, oauth } = context.get('dependencies');
  const [connectedProviders, policies] = await Promise.all([
    database.connectedProviders(identity.userId),
    database.toolPolicies(),
  ]);
  if (!connectedProviders.has(providerId)) {
    return context.json({
      provider: { providerId, status: 'not-connected' as const, tools: [] },
      cache: aggregateToolCacheHints([]),
    });
  }
  try {
    const discovery = await discover({
      userId: identity.userId,
      providerId,
      oauth,
      mounts,
      signal: context.req.raw.signal,
    });
    return context.json({
      provider: {
        providerId,
        status: 'ready' as const,
        tools: discovery.tools.map((tool) => {
          const storedPolicy = policies.get(tool.name);
          return {
            name: tool.name,
            upstreamName: tool.upstreamName,
            title: tool.title,
            description: tool.description,
            mutability: tool.mutability,
            fingerprint: tool.fingerprint,
            state: effectivePolicyState(tool, policies),
            needsReview: storedPolicy?.fingerprint !== tool.fingerprint,
            annotations: tool.annotations ?? {},
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          };
        }),
      },
      cache: discovery.cache,
    });
  } catch (error) {
    logger.warn({ providerId, ...errorSummary(error) }, 'Admin tool discovery failed');
    return context.json({
      provider: { providerId, status: 'error' as const, tools: [] },
      cache: toolCacheHintFromError(error),
    });
  }
}

async function setDeploymentToolPolicies(
  context: AppContext,
  providerId: ProviderId,
  policies: z.infer<typeof toolPolicyBatchSchema>['tools'],
) {
  const identity = context.get('browserIdentity');
  const { database, mounts, oauth } = context.get('dependencies');
  const discovery = await discoverProviderToolsFresh({
    userId: identity.userId,
    providerId,
    oauth,
    mounts,
    signal: context.req.raw.signal,
  });
  if (!toolPolicyReviewsMatchCurrentDefinitions(discovery.tools, policies)) {
    return context.json({ error: 'A selected tool changed. Refresh and review it again' }, 409);
  }
  await database.setToolPolicies(policies.map((policy) => ({
    providerId,
    toolName: policy.toolName,
    fingerprint: policy.fingerprint,
    state: policy.state,
    updatedByUserId: identity.userId,
  })));
  return context.json({ tools: policies, cache: discovery.cache });
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
  const { database, mounts, oauth } = context.get('dependencies');
  const [connections, hidden, preferences, policies, connectedProviders] = await Promise.all([
    database.listConnections(identity.userId),
    database.hiddenProviders(identity.userId),
    database.toolPreferences(identity.userId),
    database.toolPolicies(),
    database.connectedProviders(identity.userId),
  ]);
  const discovery = await discoverConnectedTools({
    userId: identity.userId,
    connectedProviders,
    hiddenProviders: new Set(),
    oauth,
    mounts,
    signal: context.req.raw.signal,
  });
  const byProvider = new Map(connections.map((connection) => [connection.providerId, connection]));
  return {
    cache: discovery.cache,
    apps: SUPPORTED_APPS.map((providerId) => {
      const connection = byProvider.get(providerId);
      return {
        providerId,
        isConnected: connection !== undefined,
        isHidden: hidden.has(providerId),
        needsReconnect: connection !== undefined && (
          connection.needsReconnect || !hasRequiredScopes(providerId, connection.scopes)
        ),
        tools: discovery.tools
          .filter((tool) => tool.providerId === providerId && effectivePolicyState(tool, policies) !== 'blocked')
          .map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            mutability: tool.mutability,
            isEnabled: isToolEnabled(tool, policies, preferences),
          })),
        toolDiscoveryFailed: discovery.failures.some((failure) => failure.providerId === providerId),
        ...(connection ? { connectedAt: connection.connectedAt.toISOString() } : {}),
        ...(connection?.accountLabel ? { accountLabel: connection.accountLabel } : {}),
      };
    }),
  };
}

function hasRequiredScopes(providerId: ProviderId, grantedScopes: readonly string[]): boolean {
  const provider = PROVIDER_REGISTRY.find((entry) => entry.id === providerId);
  if (!provider) return false;
  const granted = new Set(grantedScopes);
  return provider.scopes.every((scope) => granted.has(scope));
}
