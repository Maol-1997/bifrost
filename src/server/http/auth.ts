import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../config.js';
import { SESSION_TTL_SECONDS } from '../db.js';
import { logger } from '../logger.js';
import type { AgentIdentity, BrowserIdentity } from '../mcp.js';
import type { GoogleAuthorizationStart } from '../oauth.js';
import { canonicalResource, MCP_SCOPE } from '../oauth-server/metadata.js';
import type { AppContext } from './context.js';

export const SESSION_COOKIE = 'bifrost_session';
export const GOOGLE_OAUTH_NONCE_COOKIE = 'bifrost_google_oauth_nonce';

/**
 * The cookie path: a human in a browser.
 *
 * Cookies and bearer tokens resolve against different tables and mean different
 * things. Keeping them apart is why a leaked session cookie cannot be replayed
 * as an API credential, and why an access token cannot reach the account screens.
 */
export async function authenticateBrowser(context: AppContext): Promise<BrowserIdentity | undefined> {
  const { config, database } = context.get('dependencies');
  const request = context.req.raw;
  const development = developmentIdentityFields(request, config);
  if (development) return { kind: 'browser', sessionId: 'development-session', ...development };
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
export async function authenticateAgent(context: AppContext): Promise<AgentIdentity | undefined> {
  const { config, database } = context.get('dependencies');
  const request = context.req.raw;
  const development = developmentIdentityFields(request, config);
  if (development) return { kind: 'agent', grantId: 'development-grant', ...development };
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

export function setGoogleOAuthNonceCookie(
  context: AppContext,
  authorization: GoogleAuthorizationStart,
): void {
  setCookie(context, GOOGLE_OAUTH_NONCE_COOKIE, authorization.browserNonce, {
    ...googleOAuthNonceCookieOptions(context.get('dependencies').config),
    maxAge: authorization.expiresInSeconds,
  });
}

export function readGoogleOAuthNonceCookie(context: AppContext): string | undefined {
  return getCookie(context, GOOGLE_OAUTH_NONCE_COOKIE);
}

export function clearGoogleOAuthNonceCookie(context: AppContext): void {
  deleteCookie(
    context,
    GOOGLE_OAUTH_NONCE_COOKIE,
    googleOAuthNonceCookieOptions(context.get('dependencies').config),
  );
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

function googleOAuthNonceCookieOptions(config: Config): {
  httpOnly: true;
  sameSite: 'Lax';
  path: '/auth/google/callback';
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/auth/google/callback',
    secure: config.NODE_ENV === 'production',
  };
}

type DevelopmentIdentityFields = Pick<
  BrowserIdentity,
  'userId' | 'clientId' | 'expiresAt' | 'token' | 'scopes'
>;

function developmentIdentityFields(request: Request, config: Config): DevelopmentIdentityFields | undefined {
  const devUserId = request.headers.get('x-bifrost-dev-user') ?? undefined;
  if (config.NODE_ENV !== 'development' || !config.BIFROST_DEV_USER_ID || devUserId !== config.BIFROST_DEV_USER_ID) return undefined;
  return {
    userId: devUserId,
    clientId: request.headers.get('x-bifrost-client-id') ?? 'development-client',
    expiresAt: new Date(Date.now() + 3_600_000), token: 'development-header-auth', scopes: [MCP_SCOPE],
  };
}
