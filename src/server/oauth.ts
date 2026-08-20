import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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
  dynamicClientRegistration,
  None,
  randomPKCECodeVerifier,
  randomState,
  refreshTokenGrant,
  ResponseBodyError,
} from 'openid-client';
import { z } from 'zod';
import { WEB_CLIENT_ID } from './clients/describe.js';
import type { Config } from './config.js';
import type { Coordinator } from './coordination.js';
import type { Database, StoredCredential } from './db.js';
import { AgentFacingError } from './errors.js';
import { errorSummary, logger } from './logger.js';
import { PROVIDER_REGISTRY, SUPPORTED_APPS } from './providers/registry.js';
import { normalizeSlackTokenResponse } from './providers/slack-oauth.js';
import type { ProviderDefinition, ProviderId } from './providers/types.js';
import { emailDomain, isEmailAllowed } from './security/access.js';

const OAUTH_STATE_TTL_SECONDS = 600;
const GOOGLE_BROWSER_NONCE_BYTES = 32;
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
const returnToSchema = z.string().refine(isSafeReturnTo);

type ProviderTokenResponse = z.infer<typeof tokenResponseSchema>;
type OAuthDatabase = Pick<Database,
  'createSession' | 'getCredential' | 'saveCredential' | 'setAccountLabel' | 'upsertUser'
>;
type OAuthCoordinator = Pick<Coordinator, 'setEphemeral' | 'takeEphemeral' | 'withLock'>;

type ProviderOAuthDependencies = {
  authorizationCodeGrant: (request: {
    configuration: Configuration;
    callbackUrl: URL;
    verifier: string;
    state: string;
    tokenEndpointParameters: Record<string, string> | undefined;
  }) => Promise<unknown>;
  refreshTokenGrant: (request: {
    configuration: Configuration;
    refreshToken: string;
    tokenEndpointParameters: Record<string, string> | undefined;
  }) => Promise<unknown>;
  readAccountLabel: (request: {
    reader: NonNullable<ProviderDefinition['readAccountLabel']>;
    accessToken: string;
    signal: AbortSignal;
  }) => Promise<string>;
};

const defaultProviderOAuthDependencies: ProviderOAuthDependencies = {
  authorizationCodeGrant: async (request) => await authorizationCodeGrant(
    request.configuration,
    request.callbackUrl,
    { pkceCodeVerifier: request.verifier, expectedState: request.state },
    request.tokenEndpointParameters,
  ),
  refreshTokenGrant: async (request) => await refreshTokenGrant(
    request.configuration,
    request.refreshToken,
    request.tokenEndpointParameters,
  ),
  readAccountLabel: async (request) => await request.reader(request.accessToken, request.signal),
};

const oauthStateSchema = z.object({
  userId: z.uuid().optional(),
  providerId: z.enum(SUPPORTED_APPS).optional(),
  oauthClientId: z.string().min(1).optional(),
  browserNonceHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  verifier: z.string().min(43),
  returnTo: returnToSchema,
});

type ProviderOAuthClient = {
  configuration: Configuration;
  oauthClientId?: string;
};

export type GoogleAuthorizationStart = {
  location: string;
  browserNonce: string;
  expiresInSeconds: number;
};

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
    private readonly database: OAuthDatabase,
    private readonly coordinator: OAuthCoordinator,
    private readonly providerOAuth: ProviderOAuthDependencies = defaultProviderOAuthDependencies,
  ) {}

  async startGoogleAuthorization(returnTo: string): Promise<GoogleAuthorizationStart> {
    const clientId = this.requiredConfig('GOOGLE_CLIENT_ID');
    const safeReturnTo = returnToSchema.parse(returnTo);
    const { state, verifier, challenge } = await createPkce();
    const browserNonce = randomBytes(GOOGLE_BROWSER_NONCE_BYTES).toString('base64url');
    await this.coordinator.setEphemeral(`oauth:state:${state}`, JSON.stringify({
      browserNonceHash: hashBrowserNonce(browserNonce),
      verifier,
      returnTo: safeReturnTo,
    }), OAUTH_STATE_TTL_SECONDS);
    const location = buildAuthorizationUrl(googleConfiguration(clientId), {
      redirect_uri: `${this.config.PUBLIC_URL}/auth/google/callback`,
      response_type: 'code', scope: 'openid email profile', state,
      code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    }).href;
    return { location, browserNonce, expiresInSeconds: OAUTH_STATE_TTL_SECONDS };
  }

  async finishGoogle(
    code: string,
    state: string,
    browserNonce: string | undefined,
  ): Promise<{ sessionToken: string; userId: string; returnTo: string }> {
    const storedState = await this.takeState(state);
    if (!storedState.browserNonceHash || !browserNonceMatches(browserNonce, storedState.browserNonceHash)) {
      throw new Error('Google sign-in browser binding is invalid or expired');
    }
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
    const client = await this.createProviderOAuthClient(provider);
    const { state, verifier, challenge } = await createPkce();
    await this.coordinator.setEphemeral(`oauth:state:${state}`, JSON.stringify({
      userId,
      providerId,
      verifier,
      returnTo: '/',
      ...(client.oauthClientId === undefined ? {} : { oauthClientId: client.oauthClientId }),
    }), OAUTH_STATE_TTL_SECONDS);
    const parameters = new URLSearchParams({
      redirect_uri: this.providerRedirectUri(providerId),
      response_type: 'code', state, code_challenge: challenge, code_challenge_method: 'S256',
    });
    parameters.set('scope', provider.oauth.scopes.join(providerId === 'slack' ? ',' : ' '));
    if (provider.oauth.kind === 'dynamic') parameters.set('resource', provider.oauth.resource);
    return buildAuthorizationUrl(client.configuration, parameters).href;
  }

  async finishProvider(code: string, state: string): Promise<{ userId: string; providerId: ProviderId }> {
    const storedState = await this.takeState(state);
    if (!storedState.userId || !storedState.providerId) throw new Error('OAuth state is not a provider connection state');
    const provider = findProvider(storedState.providerId);
    const configuration = this.providerConfiguration(provider, storedState.oauthClientId);
    const callbackUrl = new URL(this.providerRedirectUri(provider.id));
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);
    const tokenResponse = await this.exchangeProviderCode({
      provider,
      configuration,
      callbackUrl,
      verifier: storedState.verifier,
      state,
    });
    const credential = normalizeCredential(tokenResponse, {
      fallbackScopes: provider.oauth.scopes,
      oauthClientId: storedState.oauthClientId,
    });
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
    if (!provider.readAccountLabel) return;
    try {
      const label = await this.providerOAuth.readAccountLabel({
        reader: provider.readAccountLabel,
        accessToken,
        signal: AbortSignal.timeout(ACCOUNT_LABEL_TIMEOUT_MS),
      });
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
      let exchanged: ProviderTokenResponse;
      try {
        exchanged = await this.refreshProviderToken(provider, latest.refreshToken, latest.oauthClientId);
      } catch (error) {
        // Only the provider saying no means the user has to reconnect. A
        // network fault or a timeout says nothing about the grant, and telling
        // the user to reconnect over it would be both wrong and irreversible.
        if (error instanceof TokenExchangeRejectedError) throw new ReconnectRequiredError(providerId);
        throw error;
      }
      const refreshed = normalizeCredential(exchanged, {
        fallbackRefreshToken: latest.refreshToken,
        fallbackScopes: latest.scopes,
        oauthClientId: latest.oauthClientId,
      });
      await this.database.saveCredential(userId, providerId, refreshed);
      return refreshed.accessToken;
    });
  }

  private async exchangeProviderCode(
    request: {
      provider: ProviderDefinition;
      configuration: Configuration;
      callbackUrl: URL;
      verifier: string;
      state: string;
    },
  ): Promise<ProviderTokenResponse> {
    try {
      const tokens = await this.providerOAuth.authorizationCodeGrant({
        configuration: request.configuration,
        callbackUrl: request.callbackUrl,
        verifier: request.verifier,
        state: request.state,
        tokenEndpointParameters: this.tokenEndpointParameters(request.provider),
      });
      return tokenResponseSchema.parse(tokens);
    } catch (error) {
      if (isProviderRejection(error)) throw new TokenExchangeRejectedError(request.provider.displayName);
      throw error;
    }
  }

  private async refreshProviderToken(
    provider: ProviderDefinition,
    refreshToken: string,
    oauthClientId: string | undefined,
  ): Promise<ProviderTokenResponse> {
    try {
      const tokens = await this.providerOAuth.refreshTokenGrant({
        configuration: this.providerConfiguration(provider, oauthClientId),
        refreshToken,
        tokenEndpointParameters: this.tokenEndpointParameters(provider),
      });
      return tokenResponseSchema.parse(tokens);
    } catch (error) {
      if (isProviderRejection(error)) throw new TokenExchangeRejectedError(provider.displayName);
      throw error;
    }
  }

  private async createProviderOAuthClient(provider: ProviderDefinition): Promise<ProviderOAuthClient> {
    if (provider.oauth.kind === 'static') return { configuration: this.providerConfiguration(provider) };
    const configuration = await dynamicClientRegistration(new URL(provider.oauth.issuer), {
      client_name: 'Bifrost',
      redirect_uris: [this.providerRedirectUri(provider.id)],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: provider.oauth.scopes.join(' '),
    }, None(), {
      algorithm: provider.oauth.discoveryAlgorithm,
      timeout: TOKEN_EXCHANGE_TIMEOUT_MS / 1000,
    });
    const oauthClientId = configuration.clientMetadata().client_id;
    if (!oauthClientId) throw new Error(`${provider.displayName} dynamic registration did not return a client ID`);
    return { configuration, oauthClientId };
  }

  private providerConfiguration(provider: ProviderDefinition, oauthClientId?: string): Configuration {
    if (provider.oauth.kind === 'dynamic') {
      if (!oauthClientId) throw new ReconnectRequiredError(provider.id);
      const configuration = new Configuration({
        issuer: provider.oauth.issuer,
        authorization_endpoint: provider.oauth.authorizationUrl,
        token_endpoint: provider.oauth.tokenUrl,
      }, oauthClientId, { token_endpoint_auth_method: 'none' }, None());
      configuration.timeout = TOKEN_EXCHANGE_TIMEOUT_MS / 1000;
      return configuration;
    }
    const clientSecret = this.providerClientSecret(provider.id);
    const configuration = new Configuration({
      issuer: new URL(provider.oauth.authorizationUrl).origin,
      authorization_endpoint: provider.oauth.authorizationUrl,
      token_endpoint: provider.oauth.tokenUrl,
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

  private tokenEndpointParameters(provider: ProviderDefinition): Record<string, string> | undefined {
    return provider.oauth.kind === 'dynamic' ? { resource: provider.oauth.resource } : undefined;
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

function hashBrowserNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('base64url');
}

function browserNonceMatches(browserNonce: string | undefined, expectedHash: string): boolean {
  if (!browserNonce) return false;
  const actual = createHash('sha256').update(browserNonce).digest();
  const expected = Buffer.from(expectedHash, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isSafeReturnTo(returnTo: string): boolean {
  if (!returnTo.startsWith('/') || returnTo.startsWith('//')) return false;
  if (returnTo.includes('\\') || /%5c/i.test(returnTo) || /^\/%2f/i.test(returnTo)) return false;
  try {
    return new URL(returnTo, 'https://bifrost.invalid').origin === 'https://bifrost.invalid';
  } catch {
    return false;
  }
}

function normalizeCredential(
  tokens: z.infer<typeof tokenResponseSchema>,
  context: {
    fallbackRefreshToken?: string | undefined;
    fallbackScopes?: readonly string[] | undefined;
    oauthClientId?: string | undefined;
  } = {},
): StoredCredential {
  const userTokens = tokens.authed_user?.access_token ? tokens.authed_user : tokens;
  const accessToken = userTokens.access_token;
  if (!accessToken) throw new Error('Provider token response did not include a user access token');
  const refreshToken = userTokens.refresh_token ?? context.fallbackRefreshToken;
  const expiresIn = userTokens.expires_in;
  const returnedScopes = userTokens.scope ?? tokens.authed_user?.scope;
  const scopes = returnedScopes === undefined
    ? context.fallbackScopes ?? []
    : returnedScopes.split(/[ ,]/).filter(Boolean);
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(context.oauthClientId === undefined ? {} : { oauthClientId: context.oauthClientId }),
    ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1000) }),
    scopes,
  };
}
