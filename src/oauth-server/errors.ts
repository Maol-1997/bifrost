/**
 * OAuth error codes travel in the response body or the redirect query, and the
 * client branches on them. Modelling them as a typed error keeps the code that
 * detects a problem from also having to know how it will be rendered.
 */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'access_denied'
  | 'server_error';

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    /**
     * Shown to whoever is debugging the client, so it names the protocol
     * problem. It must never quote a token, a code or a verifier.
     */
    readonly description: string,
    /**
     * Set when the failure happened before `redirect_uri` was validated.
     * Redirecting in that case would turn the authorization endpoint into an
     * open redirect, so these have to be rendered in place instead.
     */
    readonly isRedirectUnsafe = false,
  ) {
    super(`${code}: ${description}`);
    this.name = 'OAuthError';
  }
}
