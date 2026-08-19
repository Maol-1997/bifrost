import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../config.js';
import { SESSION_TTL_SECONDS } from '../db.js';
import { logger } from '../logger.js';
import type { HumanIdentity } from '../mcp.js';
import { canonicalResource, MCP_SCOPE } from '../oauth-server/metadata.js';
import type { AppContext } from './context.js';

export const SESSION_COOKIE = 'bifrost_session';

/**
 * The cookie path: a human in a browser.
 *
 * Cookies and bearer tokens resolve against different tables and mean different
 * things. Keeping them apart is why a leaked session cookie cannot be replayed
 * as an API credential, and why an access token cannot reach the account screens.
 */
export async function authenticateBrowser(context: AppContext): Promise<HumanIdentity | undefined> {
  const { config, database } = context.get('dependencies');
  const request = context.req.raw;
  const development = developmentIdentity(request, config);
  if (development) return development;
  const token = getCookie(context, SESSION_COOKIE);
  if (!token) return undefined;
  const resolved = await database.resolveSessionAndTouch(token, request.headers.get('user-agent') ?? undefined);
  if (!resolved) return undefined;
  return {
    kind: 'browser', sessionId: resolved.sessionId, userId: resolved.userId, clientId: resolved.clientId,
    expiresAt: resolved.expiresAt, token, scopes: [MCP_SCOPE],
  };
}

/** The bearer path: an OAuth access token, which is the only thing `/mcp` accepts. */
export async function authenticateAgent(context: AppContext): Promise<HumanIdentity | undefined> {
  const { config, database } = context.get('dependencies');
  const request = context.req.raw;
  const development = developmentIdentity(request, config);
  if (development) return development;
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  if (!token) return undefined;
  const grant = await database.resolveOAuthAccessTokenAndTouch(token, request.headers.get('user-agent') ?? undefined);
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

export function setSessionCookie(context: AppContext, token: string): void {
  setCookie(context, SESSION_COOKIE, token, sessionCookieOptions(context.get('dependencies').config));
}

export function clearSessionCookie(context: AppContext): void {
  deleteCookie(context, SESSION_COOKIE, sessionCookieOptions(context.get('dependencies').config));
}

function sessionCookieOptions(config: Config): {
  httpOnly: true;
  sameSite: 'Lax';
  path: '/';
  maxAge: number;
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
    secure: config.NODE_ENV === 'production',
  };
}

function developmentIdentity(request: Request, config: Config): HumanIdentity | undefined {
  const devUserId = request.headers.get('x-bifrost-dev-user') ?? undefined;
  if (config.NODE_ENV !== 'development' || !config.BIFROST_DEV_USER_ID || devUserId !== config.BIFROST_DEV_USER_ID) return undefined;
  return {
    kind: 'browser', sessionId: 'development-session', userId: devUserId,
    clientId: request.headers.get('x-bifrost-client-id') ?? 'development-client',
    expiresAt: new Date(Date.now() + 3_600_000), token: 'development-header-auth', scopes: [MCP_SCOPE],
  };
}
