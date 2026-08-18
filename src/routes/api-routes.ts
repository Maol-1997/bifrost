import { z } from 'zod';
import { describeClient } from '../clients/describe.js';
import type { AuthenticatedContext } from '../http/context.js';
import { clearSessionCookie, json, readJsonBody, redirect } from '../http/respond.js';
import { errorSummary, logger } from '../logger.js';
import { PROVIDER_REGISTRY, SUPPORTED_APPS } from '../providers/registry.js';
import type { ProviderId } from '../providers/types.js';
import { knownToolNames, toolAvailability } from '../tools/preferences.js';
import { callbackParameters } from './public-routes.js';

const KNOWN_TOOL_NAMES = knownToolNames(PROVIDER_REGISTRY);
// A session inside this window is what the UI calls "needs renewal": still
// working, but close enough to expiry that the browser will be signed out soon.
const RENEWAL_WINDOW_MS = 7 * 86_400_000;
const providerIdSchema = z.enum(SUPPORTED_APPS);
const clientKindSchema = z.enum(['browser', 'agent']);

/** The signed-in human's own screens and the provider OAuth steps. Returns false when the path is not one of these. */
export async function handleApiRoutes(context: AuthenticatedContext): Promise<boolean> {
  const { request, response, url, deps, identity } = context;
  const { database } = deps;
  if (url.pathname === '/api/app-connections.json') {
    await appConnections(context);
    return true;
  }
  if (url.pathname === '/api/clients.json') {
    json(response, 200, await clientList(context));
    return true;
  }
  if (url.pathname === '/api/me.json') {
    const user = await database.getUser(identity.userId);
    // A live session whose user row is gone means the account was deleted out
    // from under it; that is a broken session, not an anonymous visitor.
    if (!user) json(response, 404, { error: 'Your account could not be found' });
    else json(response, 200, user);
    return true;
  }
  // The kind is in the path because a browser session and an OAuth grant are
  // different rows in different tables that happen to both be UUIDs. Guessing
  // which one an id means would be a way to act on the wrong record.
  const clientActionMatch = /^\/api\/clients\/(browser|agent)\/([0-9a-f-]{36})\/(revoke|renew)$/.exec(url.pathname);
  if (clientActionMatch && request.method === 'POST') {
    const [, kind, clientRecordId, action] = clientActionMatch;
    await clientAction(context, {
      kind: clientKindSchema.parse(kind),
      id: z.uuid().parse(clientRecordId),
      action: z.enum(['revoke', 'renew']).parse(action),
    });
    return true;
  }
  if (url.pathname === '/auth/logout' && request.method === 'POST') {
    await database.deleteSession(identity.token);
    response.setHeader('Set-Cookie', clearSessionCookie(deps.config));
    redirect(response, '/');
    return true;
  }

  const oauthStartProvider = providerInPath(url.pathname, /^\/oauth\/([a-z]+)\/start$/);
  if (oauthStartProvider) {
    redirect(response, await deps.oauth.startProviderAuthorization(identity.userId, oauthStartProvider));
    return true;
  }
  const oauthCallbackProvider = providerInPath(url.pathname, /^\/oauth\/([a-z]+)\/callback$/);
  if (oauthCallbackProvider) {
    await finishProvider(context, oauthCallbackProvider);
    return true;
  }
  const disconnectProvider = providerInPath(url.pathname, /^\/api\/connections\/([a-z]+)\/disconnect$/);
  if (disconnectProvider && request.method === 'POST') {
    await database.deleteCredential(identity.userId, disconnectProvider);
    json(response, 200, { connected: false });
    return true;
  }
  const preferenceProvider = providerInPath(url.pathname, /^\/api\/connections\/([a-z]+)\/preference$/);
  if (preferenceProvider && request.method === 'POST') {
    const body = z.object({ isHidden: z.boolean() }).parse(await readJsonBody(request));
    await database.setProviderHidden(identity.userId, preferenceProvider, body.isHidden);
    json(response, 200, { isHidden: body.isHidden });
    return true;
  }
  const toolPreferenceMatch = /^\/api\/tools\/([a-z_]+)\/preference$/.exec(url.pathname);
  if (toolPreferenceMatch && request.method === 'POST') {
    const toolName = toolPreferenceMatch[1] ?? '';
    // Checked against the registry, not accepted as text: a stored preference
    // for a tool that does not exist is a row nobody can later explain.
    if (!KNOWN_TOOL_NAMES.has(toolName)) {
      json(response, 404, { error: 'That tool does not exist' });
      return true;
    }
    const body = z.object({ isEnabled: z.boolean() }).parse(await readJsonBody(request));
    await database.setToolPreference(identity.userId, toolName, body.isEnabled);
    json(response, 200, { isEnabled: body.isEnabled });
    return true;
  }
  return false;
}

/** The provider segment of a path, only if it names a provider Bifrost actually mounts. */
function providerInPath(pathname: string, pattern: RegExp): ProviderId | undefined {
  const parsed = providerIdSchema.safeParse(pattern.exec(pathname)?.[1]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Everything that can currently reach Bifrost as this user: browser sessions and
 * OAuth grants, in one list, because from the user's side they are all just
 * "things connected to my account" and all of them are revocable here.
 */
async function clientList({ identity, deps }: AuthenticatedContext): Promise<{ clients: readonly object[] }> {
  const [sessions, grants] = await Promise.all([
    deps.database.listSessions(identity.userId),
    deps.database.listOAuthGrants(identity.userId),
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
  { response, identity, deps }: AuthenticatedContext,
  request: { kind: 'browser' | 'agent'; id: string; action: 'revoke' | 'renew' },
): Promise<void> {
  const { database, config } = deps;
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
  const wasCurrentClient = identity.kind === 'browser' && request.kind === 'browser' && request.id === identity.sessionId;
  // Revoking the session you are browsing with is a sign-out; leaving the
  // cookie behind would just make every later request 401 on a dead token.
  if (wasCurrentClient) response.setHeader('Set-Cookie', clearSessionCookie(config));
  return json(response, 200, { revoked: true, wasCurrentClient });
}

async function finishProvider({ response, url, deps }: AuthenticatedContext, expectedProvider: ProviderId): Promise<void> {
  if (url.searchParams.has('error')) return redirect(response, `/connection-result?result=cancelled&provider=${expectedProvider}`);
  try {
    const parameters = callbackParameters(url);
    const result = await deps.oauth.finishProvider(parameters.code, parameters.state);
    if (result.providerId !== expectedProvider) throw new Error('OAuth provider callback mismatch');
    redirect(response, `/connection-result?result=success&provider=${expectedProvider}`);
  } catch (error) {
    logger.warn(errorSummary(error), 'Provider OAuth callback failed');
    redirect(response, `/connection-result?result=error&provider=${expectedProvider}`);
  }
}

/**
 * Everything Integrations needs, including the real tool list.
 *
 * The tools ride along here rather than in their own endpoint because this is
 * already the per-user, per-provider view, and because a screen that draws
 * switches needs the connection state and the tool state to agree — fetching
 * them separately is how they end up disagreeing.
 */
async function appConnections({ response, identity, deps }: AuthenticatedContext): Promise<void> {
  const [connections, hidden, preferences] = await Promise.all([
    deps.database.listConnections(identity.userId),
    deps.database.hiddenProviders(identity.userId),
    deps.database.toolPreferences(identity.userId),
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
          ...toolAvailability(tool, preferences, deps.config.writeToolAllowlist),
        })),
        ...(connection ? { connectedAt: connection.connectedAt.toISOString() } : {}),
        ...(connection?.accountLabel ? { accountLabel: connection.accountLabel } : {}),
      };
    }),
  });
}
