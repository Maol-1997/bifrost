import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  AuthorizationResponseError,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  ClientError,
  ClientSecretPost,
  Configuration,
  customFetch,
  type CustomFetchOptions,
  randomPKCECodeVerifier,
  randomState,
  refreshTokenGrant,
  ResponseBodyError,
} from 'openid-client';
import { z } from 'zod';
import { WEB_CLIENT_ID } from './clients/describe.js';
import type { Config } from './config.js';
import { Coordinator } from './coordination.js';
import { Database, type StoredCredential } from './db.js';
import { AgentFacingError } from './errors.js';
import { errorSummary, logger } from './logger.js';
import { PROVIDER_REGISTRY, SUPPORTED_APPS } from './providers/registry.js';
import { normalizeSlackTokenResponse } from './providers/slack-oauth.js';
import type { ProviderDefinition, ProviderId } from './providers/types.js';
import { emailDomain, isEmailAllowed } from './security/access.js';

const OAUTH_STATE_TTL_SECONDS = 600;
const EXPIRY_SKEW_MS = 60_000;
const ACCOUNT_LABEL_TIMEOUT_MS = 5_000;
/** Shorter than the refresh lock lease, so a hung exchange releases the lock before it expires. */
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
  authed_user: z.object({
    access_token: z.string().min(1).optional(),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().positive().optional(),
    scope: z.string().optional(),
  }).optional(),
  error: z.string().optional(),
}).loose();

const oauthStateSchema = z.object({
  userId: z.uuid().optional(),
  providerId: z.enum(SUPPORTED_APPS).optional(),
  verifier: z.string().min(43),
  returnTo: z.string().startsWith('/'),
});

/** Signed in with Google successfully, but this account is not on the allowlist. */
export class EmailNotAllowedError extends Error {
  constructor() {
    super('This account is not allowed to use Bifrost');
    this.name = 'EmailNotAllowedError';
  }
}

/** The provider answered the token endpoint and declined: the grant itself is no good. */
class TokenExchangeRejectedError extends Error {
  constructor(providerName: string) {
    super(`${providerName} token exchange failed; reconnect provider`);
    this.name = 'TokenExchangeRejectedError';
  }
}

class ReconnectRequiredError extends AgentFacingError {
  constructor(providerId: ProviderId) {
    super(`${providerId} connection expired; reconnect this provider`);
    this.name = 'ReconnectRequiredError';
  }
}

export class OAuthService {
  constructor(
    private readonly config: Config,
    private readonly database: Database,
    private readonly coordinator: Coordinator,
  ) {}

  /**
   * @param returnTo Local path to land on afterwards. Validated as a path on the
   * way back out of `takeState`, so a caller cannot turn sign-in into a redirect
   * to somebody else's site.
   */
  async startGoogleAuthorization(returnTo: string): Promise<string> {
    const clientId = this.requiredConfig('GOOGLE_CLIENT_ID');
    const { state, verifier, challenge } = await createPkce();
    await this.coordinator.setEphemeral(`oauth:state:${state}`, JSON.stringify({ verifier, returnTo }), OAUTH_STATE_TTL_SECONDS);
    return buildAuthorizationUrl(googleConfiguration(clientId), {
      redirect_uri: `${this.config.PUBLIC_URL}/auth/google/callback`,
      response_type: 'code', scope: 'openid email profile', state,
      code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    }).href;
  }

  async finishGoogle(code: string, state: string): Promise<{ sessionToken: string; userId: string; returnTo: string }> {
    const storedState = await this.takeState(state);
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
      body: new URLSearchParams({
        code, client_id: this.requiredConfig('GOOGLE_CLIENT_ID'), client_secret: this.requiredConfig('GOOGLE_CLIENT_SECRET'),
        redirect_uri: `${this.config.PUBLIC_URL}/auth/google/callback`, grant_type: 'authorization_code', code_verifier: storedState.verifier,
      }),
    });
    const tokens = tokenResponseSchema.parse(await response.json());
    if (!response.ok || !tokens.id_token) throw new Error('Google sign-in failed');
    const verified = await jwtVerify(tokens.id_token, googleJwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: this.requiredConfig('GOOGLE_CLIENT_ID'),
    });
    const claims = z.object({ email: z.email(), name: z.string().min(1).default('Bifrost user'), email_verified: z.boolean() }).parse(verified.payload);
    if (!claims.email_verified) throw new Error('Google account email is not verified');
    // Checked before the upsert on purpose: a rejected account must leave no
    // row behind, or "who has an account here" stops meaning anything.
    if (!isEmailAllowed(claims.email, this.config.accessPolicy)) {
      logger.warn({ domain: emailDomain(claims.email.toLowerCase()) }, 'Rejected sign-in from a domain that is not allowed');
      throw new EmailNotAllowedError();
    }
    const userId = await this.database.upsertUser(claims.email, claims.name);
    const session = await this.database.createSession(userId, WEB_CLIENT_ID);
    return { userId, sessionToken: session.token, returnTo: storedState.returnTo };
  }

  async startProviderAuthorization(userId: string, providerId: ProviderId): Promise<string> {
    const provider = findProvider(providerId);
    const { state, verifier, challenge } = await createPkce();
    await this.coordinator.setEphemeral(`oauth:state:${state}`, JSON.stringify({ userId, providerId, verifier, returnTo: '/' }), OAUTH_STATE_TTL_SECONDS);
    const parameters = new URLSearchParams({
      redirect_uri: this.providerRedirectUri(providerId),
      response_type: 'code', state, code_challenge: challenge, code_challenge_method: 'S256',
    });
    if (providerId === 'slack') parameters.set('user_scope', provider.scopes.join(','));
    else parameters.set('scope', provider.scopes.join(' '));
    return buildAuthorizationUrl(this.providerConfiguration(provider), parameters).href;
  }

  async finishProvider(code: string, state: string): Promise<{ userId: string; providerId: ProviderId }> {
    const storedState = await this.takeState(state);
    if (!storedState.userId || !storedState.providerId) throw new Error('OAuth state is not a provider connection state');
    const provider = findProvider(storedState.providerId);
    const callbackUrl = new URL(this.providerRedirectUri(provider.id));
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);
    const tokenResponse = await this.exchangeProviderCode({
      provider,
      callbackUrl,
      verifier: storedState.verifier,
      state,
    });
    const credential = normalizeCredential(tokenResponse);
    await this.database.saveCredential(storedState.userId, provider.id, credential);
    await this.recordAccountLabel(storedState.userId, provider, credential.accessToken);
    return { userId: storedState.userId, providerId: provider.id };
  }

  /**
   * The connection is already saved and working by the time this runs, so a
   * failed identity lookup is cosmetic: Integrations just shows the date without
   * a handle. Failing the callback over it would be a far worse trade.
   */
  private async recordAccountLabel(userId: string, provider: ProviderDefinition, accessToken: string): Promise<void> {
    try {
      const label = await provider.readAccountLabel(accessToken, AbortSignal.timeout(ACCOUNT_LABEL_TIMEOUT_MS));
      await this.database.setAccountLabel(userId, provider.id, label);
    } catch (error) {
      logger.warn({ ...errorSummary(error), providerId: provider.id }, 'Could not read the connected account handle');
    }
  }

  async getOrRefreshAccessToken(userId: string, providerId: ProviderId): Promise<string> {
    const credential = await this.database.getCredential(userId, providerId);
    if (!credential) throw new ReconnectRequiredError(providerId);
    if (!credential.expiresAt || credential.expiresAt.getTime() > Date.now() + EXPIRY_SKEW_MS) return credential.accessToken;
    return this.coordinator.withLock(`oauth-refresh:${providerId}:${userId}`, async () => {
      const latest = await this.database.getCredential(userId, providerId);
      if (!latest) throw new ReconnectRequiredError(providerId);
      if (!latest.expiresAt || latest.expiresAt.getTime() > Date.now() + EXPIRY_SKEW_MS) return latest.accessToken;
      if (!latest.refreshToken) throw new ReconnectRequiredError(providerId);
      const provider = findProvider(providerId);
      let exchanged: z.infer<typeof tokenResponseSchema>;
      try {
        exchanged = await this.refreshProviderToken(provider, latest.refreshToken);
      } catch (error) {
        // Only the provider saying no means the user has to reconnect. A
        // network fault or a timeout says nothing about the grant, and telling
        // the user to reconnect over it would be both wrong and irreversible.
        if (error instanceof TokenExchangeRejectedError) throw new ReconnectRequiredError(providerId);
        throw error;
      }
      const refreshed = normalizeCredential(exchanged, latest.refreshToken);
      await this.database.saveCredential(userId, providerId, refreshed);
      return refreshed.accessToken;
    });
  }

  private async exchangeProviderCode(
    request: { provider: ProviderDefinition; callbackUrl: URL; verifier: string; state: string },
  ): Promise<z.infer<typeof tokenResponseSchema>> {
    try {
      const tokens = await authorizationCodeGrant(
        this.providerConfiguration(request.provider),
        request.callbackUrl,
        { pkceCodeVerifier: request.verifier, expectedState: request.state },
      );
      return tokenResponseSchema.parse(tokens);
    } catch (error) {
      if (isProviderRejection(error)) throw new TokenExchangeRejectedError(request.provider.displayName);
      throw error;
    }
  }

  private async refreshProviderToken(
    provider: ProviderDefinition,
    refreshToken: string,
  ): Promise<z.infer<typeof tokenResponseSchema>> {
    try {
      const tokens = await refreshTokenGrant(this.providerConfiguration(provider), refreshToken);
      return tokenResponseSchema.parse(tokens);
    } catch (error) {
      if (isProviderRejection(error)) throw new TokenExchangeRejectedError(provider.displayName);
      throw error;
    }
  }

  private providerConfiguration(provider: ProviderDefinition): Configuration {
    const clientSecret = this.providerClientSecret(provider.id);
    const configuration = new Configuration({
      issuer: new URL(provider.authorizationUrl).origin,
      authorization_endpoint: provider.authorizationUrl,
      token_endpoint: provider.tokenUrl,
    }, this.providerClientId(provider.id), {
      client_secret: clientSecret,
      token_endpoint_auth_method: 'client_secret_post',
    }, ClientSecretPost(clientSecret));
    configuration.timeout = TOKEN_EXCHANGE_TIMEOUT_MS / 1000;
    if (provider.id === 'slack') {
      configuration[customFetch] = async (url, options) => normalizeSlackTokenResponse(
        await fetch(url, fetchOptions(options)),
      );
    }
    return configuration;
  }

  private async takeState(state: string): Promise<z.infer<typeof oauthStateSchema>> {
    const raw = await this.coordinator.takeEphemeral(`oauth:state:${state}`);
    if (!raw) throw new Error('OAuth state is invalid or expired');
    return oauthStateSchema.parse(JSON.parse(raw));
  }

  private providerClientId(providerId: ProviderId): string {
    return this.requiredConfig(`${providerId.toUpperCase()}_CLIENT_ID` as keyof Config);
  }

  private providerClientSecret(providerId: ProviderId): string {
    return this.requiredConfig(`${providerId.toUpperCase()}_CLIENT_SECRET` as keyof Config);
  }

  private providerRedirectUri(providerId: ProviderId): string {
    return `${this.config.PUBLIC_URL}/oauth/${providerId}/callback`;
  }

  private requiredConfig(name: keyof Config): string {
    const value = this.config[name];
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required for this OAuth flow`);
    return value;
  }
}

async function createPkce(): Promise<{ state: string; verifier: string; challenge: string }> {
  const state = randomState();
  const verifier = randomPKCECodeVerifier();
  const challenge = await calculatePKCECodeChallenge(verifier);
  return { state, verifier, challenge };
}

function googleConfiguration(clientId: string): Configuration {
  return new Configuration({
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
  }, clientId);
}

function isProviderRejection(error: unknown): boolean {
  if (error instanceof ResponseBodyError || error instanceof AuthorizationResponseError) return true;
  return error instanceof ClientError
    && error.code !== 'OAUTH_TIMEOUT'
    && error.code !== 'OAUTH_ABORT'
    && error.message !== 'something went wrong';
}

function fetchOptions(options: CustomFetchOptions): RequestInit {
  return {
    method: options.method,
    headers: options.headers,
    redirect: options.redirect,
    ...(options.body === undefined ? {} : { body: options.body as BodyInit }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function findProvider(providerId: ProviderId): ProviderDefinition {
  const provider = PROVIDER_REGISTRY.find((entry) => entry.id === providerId);
  if (!provider) throw new Error(`Unsupported provider: ${providerId}`);
  return provider;
}

function normalizeCredential(tokens: z.infer<typeof tokenResponseSchema>, fallbackRefreshToken?: string): StoredCredential {
  const userTokens = tokens.authed_user ?? tokens;
  const accessToken = userTokens.access_token;
  if (!accessToken) throw new Error('Provider token response did not include a user access token');
  const refreshToken = userTokens.refresh_token ?? fallbackRefreshToken;
  const expiresIn = userTokens.expires_in;
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1000) }),
    scopes: (userTokens.scope ?? '').split(/[ ,]/).filter(Boolean),
  };
}
