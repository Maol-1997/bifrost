import { zValidator, type Hook } from '@hono/zod-validator';
import type { Next } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { APP_ROUTES } from '../../features/utils/routes.js';
import { createBifrostChatResponse, createBifrostChatTitle } from '../chat.js';
import { describeClient } from '../clients/describe.js';
import { errorSummary, logger } from '../logger.js';
import { PROVIDER_REGISTRY, SUPPORTED_APPS } from '../providers/registry.js';
import type { ProviderId } from '../providers/types.js';
import { effectivePolicyState, isToolEnabled, toolContractReview, TOOL_POLICY_STATES } from '../tools/catalog.js';
import { mcpToolNameSchema, type ProviderDiscoveryRequest } from '../tools/discovery.js';
import { aggregateToolCacheHints, failedToolCacheHint, toolCacheHintFromError, type CachedToolDiscovery } from '../tools/discovery-cache.js';
import { clearToolRule, saveToolRule, toolRuleInstructionsSchema } from '../tools/auto-policy.js';
import { applyToolPolicies } from '../tools/policy.js';
import { isUncertainProbability } from '../tools/rule-classifier.js';
import { recordClientRevocation } from '../oauth-server/revocation.js';
import { isAdministrator } from '../security/access.js';
import { authenticateBrowser, clearSessionCookie, setSessionCookie } from './auth.js';
import type { AppContext, AppEnv } from './context.js';
import { callbackParameters } from './public.js';
import { limitRequestBody, readJsonBody } from './request-body.js';

// A live session inside this window still works, but the UI warns that it will
// need renewal soon.
const RENEWAL_WINDOW_MS = 7 * 86_400_000;
// Comment frames keep intermediaries from closing an otherwise idle event stream.
const EVENT_STREAM_HEARTBEAT_MS = 25_000;
const providerPathSchema = z.object({ providerId: z.enum(SUPPORTED_APPS) });
const clientActionSchema = z.object({
  kind: z.enum(['browser', 'agent']),
  id: z.uuid(),
  action: z.enum(['revoke', 'renew']),
});
const providerPreferenceSchema = z.object({ isHidden: z.boolean() });
const toolPathSchema = z.object({
  toolName: mcpToolNameSchema,
});
const toolPreferenceSchema = z.object({ isEnabled: z.boolean() });
const toolPolicySchema = z.object({
  state: z.enum(TOOL_POLICY_STATES),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const toolPolicyBatchSchema = z.object({
  tools: z.array(toolPolicySchema.extend(toolPathSchema.shape)).min(1),
});
const toolRuleSchema = z.object({ instructions: toolRuleInstructionsSchema });
const chatRequestSchema = z.object({ messages: z.unknown() });
const chatTitleRequestSchema = z.object({ firstMessage: z.string().trim().min(1).max(4000) });

const validateProviderPath = validateRequest('param', providerPathSchema, { status: 404, message: 'Not found' });
const validateClientAction = validateRequest('param', clientActionSchema, { status: 404, message: 'Not found' });
const validateToolPath = validateRequest('param', toolPathSchema, { status: 404, message: 'That tool does not exist' });
const validateProviderPreference = validateRequest('json', providerPreferenceSchema, { status: 400, message: 'Invalid request body' });
const validateToolPreference = validateRequest('json', toolPreferenceSchema, { status: 400, message: 'Invalid request body' });
const validateToolPolicyBatch = validateRequest('json', toolPolicyBatchSchema, { status: 400, message: 'Invalid request body' });
const validateToolRule = validateRequest('json', toolRuleSchema, { status: 400, message: 'Invalid request body' });

export function createBrowserRoutes() {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireBrowserIdentity);
  routes.use('*', limitRequestBody);
  routes.use('/api/admin/*', requireAdministrator);

  return routes
    .get('/api/app-connections.json', async (context) => context.json(await appConnections(context)))
    .get('/api/events', (context) => browserEventStream(context))
    .get('/api/clients.json', async (context) => context.json(await clientList(context)))
    .get('/api/me.json', async (context) => {
      const user = await context.get('dependencies').database.getUser(context.get('browserIdentity').userId);
      if (!user) return context.json({ error: 'Your account could not be found' }, 404);
      return context.json({ ...user, isAdmin: isAdministrator(user.email, context.get('dependencies').config.adminEmails) });
    })
    .get('/api/chat/config.json', (context) => context.json({
      configured: Boolean(context.get('dependencies').config.OPENAI_API_KEY),
    }))
    .post('/api/chat/title', async (context) => {
      const parsed = chatTitleRequestSchema.safeParse(await readJsonBody(context));
      if (!parsed.success) return context.json({ error: 'Invalid request body' }, 400);
      const title = await createBifrostChatTitle({
        dependencies: context.get('dependencies'),
        firstMessage: parsed.data.firstMessage,
        signal: context.req.raw.signal,
      });
      return context.json({ title });
    })
    .post('/api/chat', async (context) => {
      const parsed = chatRequestSchema.safeParse(await readJsonBody(context));
      if (!parsed.success) return context.json({ error: 'Invalid request body' }, 400);
      return createBifrostChatResponse({
        dependencies: context.get('dependencies'),
        identity: context.get('browserIdentity'),
        messages: parsed.data.messages,
        signal: context.req.raw.signal,
      });
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
      ),
    )
    .post(
      '/api/admin/providers/:providerId/tools/refresh',
      validateProviderPath,
      (context) => refreshAdminProviderToolList(
        context,
        context.req.valid('param').providerId,
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
    )
    .put(
      '/api/admin/tools/:providerId/rule',
      validateProviderPath,
      validateToolRule,
      (context) => setAutomaticToolRule(
        context,
        context.req.valid('param').providerId,
        context.req.valid('json').instructions,
      ),
    )
    .delete(
      '/api/admin/tools/:providerId/rule',
      validateProviderPath,
      (context) => clearAutomaticToolRule(context, context.req.valid('param').providerId),
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

function browserEventStream(context: AppContext): Response {
  const { events } = context.get('dependencies');
  const userId = context.get('browserIdentity').userId;
  return streamSSE(context, async (stream) => {
    const unsubscribe = events.subscribe(userId, (event) => {
      void stream.writeSSE({ event, data: '' });
    });
    const heartbeat = setInterval(() => {
      void stream.write(': heartbeat\n\n');
    }, EVENT_STREAM_HEARTBEAT_MS);
    // Returning closes the stream, so hold it open until the browser goes away.
    await new Promise<void>((resolve) => { stream.onAbort(resolve); });
    clearInterval(heartbeat);
    unsubscribe();
  });
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
    return context.redirect(APP_ROUTES.integrations);
  }
  try {
    const parameters = callbackParameters(url);
    const result = await context.get('dependencies').oauth.finishProvider(
      parameters.code,
      parameters.state,
      context.get('browserIdentity').userId,
    );
    if (result.providerId !== expectedProvider) throw new Error('OAuth provider callback mismatch');
    await context.get('dependencies').toolDiscovery.invalidateProvider(result.userId, result.providerId);
    await context.get('dependencies').events.emit(result.userId, 'providers-changed');
    return context.redirect(APP_ROUTES.integrations);
  } catch (error) {
    logger.warn(errorSummary(error), 'Provider OAuth callback failed');
    return context.redirect(APP_ROUTES.integrations);
  }
}

async function disconnectProvider(context: AppContext, providerId: ProviderId) {
  const { database, events, toolDiscovery } = context.get('dependencies');
  const userId = context.get('browserIdentity').userId;
  await database.deleteCredential(userId, providerId);
  await toolDiscovery.invalidateProvider(userId, providerId);
  await events.emit(userId, 'providers-changed');
  return context.json({ connected: false });
}

async function setProviderPreference(
  context: AppContext,
  providerId: ProviderId,
  preference: z.infer<typeof providerPreferenceSchema>,
) {
  const { database, events } = context.get('dependencies');
  const userId = context.get('browserIdentity').userId;
  await database.setProviderHidden(userId, providerId, preference.isHidden);
  await events.emit(userId, 'providers-changed');
  return context.json(preference);
}

async function setToolPreference(
  context: AppContext,
  toolName: string,
  preference: z.infer<typeof toolPreferenceSchema>,
) {
  const identity = context.get('browserIdentity');
  const { database, events, toolDiscovery } = context.get('dependencies');
  const [connectedProviders, policies] = await Promise.all([
    database.connectedProviders(identity.userId),
    database.toolPolicies(),
  ]);
  const discovery = await toolDiscovery.discoverConnected({
    userId: identity.userId,
    connectedProviders,
    hiddenProviders: new Set(),
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
  await events.emit(identity.userId, 'providers-changed');
  return context.json(preference);
}

type ProviderToolDiscoverer = (request: ProviderDiscoveryRequest) => Promise<CachedToolDiscovery>;

async function refreshAdminProviderToolList(context: AppContext, providerId: ProviderId) {
  return renderAdminProviderToolList(
    context,
    providerId,
    (request) => context.get('dependencies').toolDiscovery.discoverProviderFresh(request),
  );
}

async function adminProviderToolList(
  context: AppContext,
  providerId: ProviderId,
) {
  return renderAdminProviderToolList(
    context,
    providerId,
    (request) => context.get('dependencies').toolDiscovery.discoverProvider(request),
  );
}

async function renderAdminProviderToolList(
  context: AppContext,
  providerId: ProviderId,
  discover: ProviderToolDiscoverer,
) {
  const identity = context.get('browserIdentity');
  const { config, database } = context.get('dependencies');
  const [connectedProviders, policies, origins, storedRule] = await Promise.all([
    database.connectedProviders(identity.userId),
    database.toolPolicies(),
    database.toolPolicyOrigins(providerId),
    database.toolRule(providerId),
  ]);
  const rule = {
    isAvailable: Boolean(config.OPENROUTER_API_KEY),
    ...(storedRule ? { instructions: storedRule.instructions, revision: storedRule.revision, updatedAt: storedRule.updatedAt.toISOString() } : {}),
  };
  if (!connectedProviders.has(providerId)) {
    return context.json({
      provider: { providerId, status: 'not-connected' as const, tools: [], rule },
      cache: aggregateToolCacheHints([]),
    });
  }
  try {
    const discovery = await discover({
      userId: identity.userId,
      providerId,
      signal: context.req.raw.signal,
    });
    return context.json({
      provider: {
        providerId,
        status: 'ready' as const,
        rule,
        tools: discovery.tools.map((tool) => {
          const review = toolContractReview(tool, policies);
          const origin = origins.get(tool.name);
          const autoProbability = origin?.source === 'auto' && origin.fingerprint === tool.fingerprint
            ? origin.autoProbability
            : null;
          return {
            name: tool.name,
            upstreamName: tool.upstreamName,
            title: tool.title,
            description: tool.description,
            mutability: tool.mutability,
            fingerprint: tool.fingerprint,
            state: effectivePolicyState(tool, policies),
            needsReview: review.kind !== 'approved',
            review,
            autoProbability,
            isUncertain: autoProbability !== null && isUncertainProbability(autoProbability),
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
      provider: { providerId, status: 'error' as const, tools: [], rule },
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
  const outcome = await applyToolPolicies({
    userId: identity.userId,
    providerId,
    changes: policies,
    signal: context.req.raw.signal,
    dependencies: context.get('dependencies'),
  });
  if (outcome.status === 'stale') {
    return context.json({ error: 'A selected tool changed. Refresh and review it again' }, 409);
  }
  return context.json({ tools: policies, cache: outcome.cache });
}

async function setAutomaticToolRule(context: AppContext, providerId: ProviderId, instructions: string) {
  const result = await saveToolRule({
    userId: context.get('browserIdentity').userId,
    providerId,
    instructions,
    signal: context.req.raw.signal,
    dependencies: context.get('dependencies'),
  });
  if (result.status === 'not-configured') {
    return context.json({ error: 'Automatic rules need OPENROUTER_API_KEY on the server' }, 409);
  }
  return context.json({ revision: result.revision, classification: result.classification });
}

async function clearAutomaticToolRule(context: AppContext, providerId: ProviderId) {
  await clearToolRule({ providerId, dependencies: context.get('dependencies') });
  return context.json({ cleared: true });
}

async function handleClientAction(
  context: AppContext,
  request: z.infer<typeof clientActionSchema>,
) {
  const { database, events } = context.get('dependencies');
  const identity = context.get('browserIdentity');

  if (request.action === 'renew') {
    if (request.kind === 'agent') {
      return context.json({ error: 'This client keeps itself connected and does not need renewing' }, 400);
    }
    if (request.id !== identity.sessionId) {
      return context.json({ error: 'A browser session can only renew itself' }, 409);
    }
    const renewedUntil = await database.renewSession(identity.userId, request.id);
    if (!renewedUntil) {
      return context.json({ error: 'That client has to sign in again before it can keep working' }, 409);
    }
    setSessionCookie(context, identity.token);
    await events.emit(identity.userId, 'clients-changed');
    return context.json({ expiresAt: renewedUntil.toISOString() });
  }

  const isRevoked = request.kind === 'agent'
    ? await revokeAgentGrant(context, request.id)
    : await database.revokeSession(identity.userId, request.id);
  if (!isRevoked) return context.json({ error: 'That client is no longer connected' }, 404);
  const wasCurrentClient = request.kind === 'browser'
    && request.id === identity.sessionId;
  if (wasCurrentClient) clearSessionCookie(context);
  await events.emit(identity.userId, 'clients-changed');
  return context.json({ revoked: true, wasCurrentClient });
}

async function revokeAgentGrant(context: AppContext, grantId: string): Promise<boolean> {
  const { coordinator, database } = context.get('dependencies');
  const userId = context.get('browserIdentity').userId;
  const revoked = await database.revokeOAuthGrant(userId, grantId);
  if (!revoked) return false;
  await recordClientRevocation(coordinator, userId, revoked.clientId);
  return true;
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
      isCurrent: session.id === identity.sessionId,
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
  const { database, oauth, toolDiscovery } = context.get('dependencies');
  const connectedProviders = await database.connectedProviders(identity.userId);
  const connectionHealth = new Map(await Promise.all([...connectedProviders].map(async (providerId) => [
    providerId,
    await oauth.refreshProviderConnectionIfNeeded(identity.userId, providerId),
  ] as const)));
  const [connections, hidden, preferences, policies, discovery] = await Promise.all([
    database.listConnections(identity.userId),
    database.hiddenProviders(identity.userId),
    database.toolPreferences(identity.userId),
    database.toolPolicies(),
    toolDiscovery.discoverConnected({
      userId: identity.userId,
      connectedProviders,
      hiddenProviders: new Set(),
      signal: context.req.raw.signal,
    }),
  ]);
  const byProvider = new Map(connections.map((connection) => [connection.providerId, connection]));
  const hasUnknownConnectionHealth = [...connectionHealth.values()].some((health) => health === 'unknown');
  return {
    cache: aggregateToolCacheHints([
      discovery.cache,
      ...(hasUnknownConnectionHealth ? [failedToolCacheHint()] : []),
    ]),
    apps: SUPPORTED_APPS.map((providerId) => {
      const connection = byProvider.get(providerId);
      return {
        providerId,
        isConnected: connection !== undefined,
        isHidden: hidden.has(providerId),
        needsReconnect: connection !== undefined && (
          connectionHealth.get(providerId) === 'needs-reconnect'
          || !hasRequiredScopes(providerId, connection.scopes)
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
  return provider.oauth.scopes.every((scope) => granted.has(scope));
}
