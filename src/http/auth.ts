import type { IncomingMessage } from 'node:http';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { logger } from '../logger.js';
import type { HumanIdentity } from '../mcp.js';
import { canonicalResource, MCP_SCOPE } from '../oauth-server/metadata.js';
import { headerValue, parseCookies, SESSION_COOKIE } from './respond.js';

/**
 * The cookie path: a human in a browser.
 *
 * Cookies and bearer tokens resolve against different tables and mean different
 * things. Keeping them apart is why a leaked session cookie cannot be replayed
 * as an API credential, and why an access token cannot reach the account screens.
 */
export async function authenticateBrowser(request: IncomingMessage, database: Database, config: Config): Promise<HumanIdentity | undefined> {
  const development = developmentIdentity(request, config);
  if (development) return development;
  const token = parseCookies(headerValue(request, 'cookie'))[SESSION_COOKIE];
  if (!token) return undefined;
  const resolved = await database.resolveSessionAndTouch(token, headerValue(request, 'user-agent'));
  if (!resolved) return undefined;
  return {
    kind: 'browser', sessionId: resolved.sessionId, userId: resolved.userId, clientId: resolved.clientId,
    expiresAt: resolved.expiresAt, token, scopes: [MCP_SCOPE],
  };
}

/** The bearer path: an OAuth access token, which is the only thing `/mcp` accepts. */
export async function authenticateAgent(request: IncomingMessage, database: Database, config: Config): Promise<HumanIdentity | undefined> {
  const development = developmentIdentity(request, config);
  if (development) return development;
  const token = headerValue(request, 'authorization')?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  if (!token) return undefined;
  const grant = await database.resolveOAuthAccessTokenAndTouch(token, headerValue(request, 'user-agent'));
  if (!grant) return undefined;
  // Audience binding. Every token Bifrost issues names this resource, so a
  // mismatch means the value came from somewhere else and is not ours to honour.
  if (grant.resource !== canonicalResource(config.PUBLIC_URL)) {
    logger.warn({ clientId: grant.clientId, resource: grant.resource }, 'Rejected an access token issued for a different resource');
    return undefined;
  }
  return {
    kind: 'agent', grantId: grant.grantId, userId: grant.userId, clientId: grant.clientId,
    expiresAt: grant.expiresAt, token, scopes: grant.scopes,
  };
}

function developmentIdentity(request: IncomingMessage, config: Config): HumanIdentity | undefined {
  const devUserId = headerValue(request, 'x-bifrost-dev-user');
  if (config.NODE_ENV !== 'development' || !config.BIFROST_DEV_USER_ID || devUserId !== config.BIFROST_DEV_USER_ID) return undefined;
  return {
    kind: 'browser', sessionId: 'development-session', userId: devUserId,
    clientId: headerValue(request, 'x-bifrost-client-id') ?? 'development-client',
    expiresAt: new Date(Date.now() + 3_600_000), token: 'development-header-auth', scopes: [MCP_SCOPE],
  };
}
