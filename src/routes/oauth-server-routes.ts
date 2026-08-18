import type { ServerResponse } from 'node:http';
import type { HumanIdentity } from '../mcp.js';
import type { OAuthService } from '../oauth.js';
import { handleAuthorize, handleConsent } from '../oauth-server/authorize.js';
import type { OAuthHttpResult, OAuthServerContext } from '../oauth-server/context.js';
import {
  authorizationServerMetadata, AUTHORIZATION_SERVER_PATH, AUTHORIZE_PATH, CONSENT_PATH,
  protectedResourceMetadata, PROTECTED_RESOURCE_PATH, REGISTER_PATH, REVOKE_PATH, TOKEN_PATH,
} from '../oauth-server/metadata.js';
import { handleRegister, handleRevoke, handleToken } from '../oauth-server/token.js';
import type { RequestContext } from '../http/context.js';
import { html, json, readFormBody, readJsonBody, redirect } from '../http/respond.js';

/**
 * Bifrost as an OAuth 2.1 authorization server. Discovery and the token-side
 * endpoints need no cookie: the caller is a program holding a code or a refresh
 * token, not a browser holding a session. Returns false when the path is not one of these.
 */
export async function handleOAuthServerRoutes(context: RequestContext): Promise<boolean> {
  const { request, response, url, deps } = context;
  // Public by necessity: a client reads these before it has any credential, and
  // the whole point of the flow is that it can bootstrap itself from a bare URL.
  // RFC 9728 lets the document sit under the resource's path or at the root, and
  // clients probe in that order, so both are served.
  if (url.pathname === `${PROTECTED_RESOURCE_PATH}/mcp` || url.pathname === PROTECTED_RESOURCE_PATH) {
    json(response, 200, protectedResourceMetadata(deps.config.PUBLIC_URL));
    return true;
  }
  if (url.pathname === AUTHORIZATION_SERVER_PATH) {
    json(response, 200, authorizationServerMetadata(deps.config.PUBLIC_URL, deps.config.OAUTH_ENABLE_CLIENT_ID_METADATA_DOCUMENTS));
    return true;
  }
  if (request.method !== 'POST') return false;
  const oauthContext = oauthServerContext(context);
  if (url.pathname === REGISTER_PATH) {
    await sendOAuthResult(response, await handleRegister(oauthContext, await readJsonBody(request)), deps.oauth);
    return true;
  }
  if (url.pathname === TOKEN_PATH) {
    await sendOAuthResult(response, await handleToken(oauthContext, await readFormBody(request)), deps.oauth);
    return true;
  }
  if (url.pathname === REVOKE_PATH) {
    await sendOAuthResult(response, await handleRevoke(oauthContext, await readFormBody(request)), deps.oauth);
    return true;
  }
  return false;
}

/**
 * The two OAuth steps a human drives. The cookie is optional: arriving signed
 * out is the normal first visit, and the handler answers with a sign-in
 * redirect rather than a 401.
 */
export async function handleOAuthConsentRoutes(context: RequestContext, identity: HumanIdentity | undefined): Promise<boolean> {
  const { request, response, url, deps } = context;
  if (url.pathname === AUTHORIZE_PATH) {
    await sendOAuthResult(response, await handleAuthorize(oauthServerContext(context), url, identity?.userId), deps.oauth);
    return true;
  }
  if (url.pathname === CONSENT_PATH && request.method === 'POST') {
    await sendOAuthResult(response, await handleConsent(oauthServerContext(context), await readFormBody(request), identity?.userId), deps.oauth);
    return true;
  }
  return false;
}

function oauthServerContext({ deps }: RequestContext): OAuthServerContext {
  return { config: deps.config, database: deps.database, coordinator: deps.coordinator };
}

async function sendOAuthResult(response: ServerResponse, result: OAuthHttpResult, oauth: OAuthService): Promise<void> {
  // OAuth responses carry codes and tokens, so none of them may be stored by an
  // intermediary — including the error bodies, which echo request parameters.
  response.setHeader('Cache-Control', 'no-store');
  if (result.kind === 'redirect') return redirect(response, result.location);
  if (result.kind === 'json') return json(response, result.status, result.body);
  if (result.kind === 'html') return html(response, result.status, result.body);
  return redirect(response, await oauth.startGoogleAuthorization(result.returnTo));
}
