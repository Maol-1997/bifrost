import { SUPPORTED_GRANT_TYPES } from './clients.js';
/**
 * The documents an MCP client reads to discover how to authenticate, and the
 * challenge that points it at them.
 *
 * Pure on purpose: every value here is derived from `PUBLIC_URL`, and getting
 * one of them wrong is the difference between a client that connects by itself
 * and one that cannot start the flow at all.
 */

/**
 * The single scope Bifrost issues. Per-provider scopes would be the natural next
 * axis, which is why grants store a `text[]` rather than one string.
 */
export const MCP_SCOPE = 'mcp';

export const MCP_PATH = '/mcp';
export const AUTHORIZE_PATH = '/oauth/authorize';
export const CONSENT_PATH = '/oauth/consent';
export const TOKEN_PATH = '/oauth/token';
export const REGISTER_PATH = '/oauth/register';
export const REVOKE_PATH = '/oauth/revoke';
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server';

/**
 * The issuer identifier, which RFC 8414 requires to be byte-identical to the
 * value a client used to build the discovery URL. A stray trailing slash here
 * makes a conforming client reject the document outright.
 */
export function issuerUrl(publicUrl: string): string {
  return publicUrl.replace(/\/+$/, '');
}

/** The RFC 8707 audience. A token is only valid at the resource it names. */
export function canonicalResource(publicUrl: string): string {
  return `${issuerUrl(publicUrl)}${MCP_PATH}`;
}

/**
 * Where the protected resource metadata lives for our MCP endpoint. RFC 9728
 * inserts the resource's path after the well-known segment, so a server at
 * `/mcp` publishes at `/.well-known/oauth-protected-resource/mcp`.
 */
export function protectedResourceMetadataUrl(publicUrl: string): string {
  return `${issuerUrl(publicUrl)}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`;
}

export function protectedResourceMetadata(publicUrl: string): Record<string, unknown> {
  return {
    resource: canonicalResource(publicUrl),
    authorization_servers: [issuerUrl(publicUrl)],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Bifrost',
  };
}

/**
 * `code_challenge_methods_supported` is load-bearing rather than informational:
 * the spec tells clients to refuse to proceed when it is absent, because that is
 * the only way they can confirm PKCE is enforced.
 *
 * `token_endpoint_auth_methods_supported: ["none"]` says these are public
 * clients with no secret, which is also what Claude Code checks before it will
 * use a Client ID Metadata Document instead of dynamic registration.
 */
export function authorizationServerMetadata(publicUrl: string, isClientIdMetadataDocumentEnabled: boolean): Record<string, unknown> {
  const issuer = issuerUrl(publicUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${TOKEN_PATH}`,
    registration_endpoint: `${issuer}${REGISTER_PATH}`,
    revocation_endpoint: `${issuer}${REVOKE_PATH}`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: [...SUPPORTED_GRANT_TYPES],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: isClientIdMetadataDocumentEnabled,
  };
}

/**
 * The `WWW-Authenticate` challenge. Without it a client has nothing to act on: a
 * bare 401 is where the old "sign in with Google" JSON left every agent stuck.
 *
 * `error="invalid_token"` matters for the refresh loop. A client that sees it
 * knows the credential went stale and reaches for its refresh token, where a
 * plain challenge would send it back through discovery and consent.
 */
export function bearerChallenge(publicUrl: string, error?: 'invalid_token'): string {
  const parameters = [
    `resource_metadata="${protectedResourceMetadataUrl(publicUrl)}"`,
    `scope="${MCP_SCOPE}"`,
  ];
  if (error) parameters.unshift(`error="${error}"`);
  return `Bearer ${parameters.join(', ')}`;
}
