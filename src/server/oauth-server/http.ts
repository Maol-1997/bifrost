import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { authenticateBrowser, setGoogleOAuthNonceCookie } from '../http/auth.js';
import type { AppContext, AppEnv } from '../http/context.js';
import { limitRequestBody, readFormBody, readJsonBody } from '../http/request-body.js';
import { handleAuthorize, handleConsent } from './authorize.js';
import type { OAuthHttpResult, OAuthServerContext } from './context.js';
import {
  authorizationServerMetadata,
  AUTHORIZATION_SERVER_PATH,
  AUTHORIZE_PATH,
  CONSENT_PATH,
  protectedResourceMetadata,
  PROTECTED_RESOURCE_PATH,
  REGISTER_PATH,
  REVOKE_PATH,
  TOKEN_PATH,
} from './metadata.js';
import { handleRegister, handleRevoke, handleToken } from './token.js';

export function createOAuthRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('/oauth/*', preventOAuthResponseCaching);

  routes.get(`${PROTECTED_RESOURCE_PATH}/mcp`, protectedResourceDocument);
  routes.get(PROTECTED_RESOURCE_PATH, protectedResourceDocument);
  routes.get(AUTHORIZATION_SERVER_PATH, authorizationServerDocument);
  routes.post(REGISTER_PATH, limitRequestBody, registerClient);
  routes.post(TOKEN_PATH, limitRequestBody, exchangeToken);
  routes.post(REVOKE_PATH, limitRequestBody, revokeToken);
  routes.get(AUTHORIZE_PATH, authorizeClient);
  routes.post(CONSENT_PATH, limitRequestBody, submitConsent);
  return routes;
}

const preventOAuthResponseCaching: MiddlewareHandler<AppEnv> = async (context, next) => {
  // OAuth errors can echo request parameters just like successful responses
  // can carry codes and tokens, so every protocol response is non-cacheable.
  context.header('Cache-Control', 'no-store');
  await next();
};

function protectedResourceDocument(context: AppContext): Response {
  return context.json(protectedResourceMetadata(context.get('dependencies').config.PUBLIC_URL));
}

function authorizationServerDocument(context: AppContext): Response {
  const { config } = context.get('dependencies');
  return context.json(authorizationServerMetadata(config.PUBLIC_URL, config.OAUTH_ENABLE_CLIENT_ID_METADATA_DOCUMENTS));
}

async function registerClient(context: AppContext): Promise<Response> {
  const result = await handleRegister(oauthServerContext(context), await readJsonBody(context));
  return sendOAuthResult(context, result);
}

async function exchangeToken(context: AppContext): Promise<Response> {
  const result = await handleToken(oauthServerContext(context), await readFormBody(context));
  return sendOAuthResult(context, result);
}

async function revokeToken(context: AppContext): Promise<Response> {
  const result = await handleRevoke(oauthServerContext(context), await readFormBody(context));
  return sendOAuthResult(context, result);
}

async function authorizeClient(context: AppContext): Promise<Response> {
  const identity = await authenticateBrowser(context);
  const result = await handleAuthorize(oauthServerContext(context), new URL(context.req.url), identity?.userId);
  return sendOAuthResult(context, result);
}

async function submitConsent(context: AppContext): Promise<Response> {
  const identity = await authenticateBrowser(context);
  const result = await handleConsent(oauthServerContext(context), await readFormBody(context), identity?.userId);
  return sendOAuthResult(context, result);
}

function oauthServerContext(context: AppContext): OAuthServerContext {
  const { config, coordinator, database } = context.get('dependencies');
  return { config, database, coordinator };
}

async function sendOAuthResult(context: AppContext, result: OAuthHttpResult): Promise<Response> {
  if (result.kind === 'redirect') return context.redirect(result.location);
  if (result.kind === 'json') return context.json(result.body, result.status as ContentfulStatusCode);
  if (result.kind === 'html') return context.html(result.body, result.status as ContentfulStatusCode);
  const authorization = await context.get('dependencies').oauth.startGoogleAuthorization(result.returnTo);
  setGoogleOAuthNonceCookie(context, authorization);
  return context.redirect(authorization.location);
}
