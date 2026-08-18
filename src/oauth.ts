import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Config } from './config.js';
import { Coordinator } from './coordination.js';
import { Database, type StoredCredential } from './db.js';
import { PROVIDER_REGISTRY } from './providers/registry.js';
import type { ProviderDefinition, ProviderId } from './providers/types.js';

const OAUTH_STATE_TTL_SECONDS = 600;
const EXPIRY_SKEW_MS = 60_000;
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
  providerId: z.enum(['github', 'linear', 'slack']).optional(),
  verifier: z.string().min(43),
  returnTo: z.string().startsWith('/'),
});

export class ReconnectRequiredError extends Error {
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

  async googleAuthorizationUrl(): Promise<string> {
    const clientId = this.requiredConfig('GOOGLE_CLIENT_ID');
    const { state, verifier, challenge } = createPkce();
    await this.coordinator.setEphemeral(`oauth:state:${state}`, JSON.stringify({ verifier, returnTo: '/' }), OAUTH_STATE_TTL_SECONDS);
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${this.config.PUBLIC_URL}/auth/google/callback`,
      response_type: 'code', scope: 'openid email profile', state,
      code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`;
  }

  async finishGoogle(code: string, state: string): Promise<{ sessionToken: string; userId: string }> {
    const storedState = await this.takeState(state);
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
    const userId = await this.database.upsertUser(claims.email, claims.name);
    return { userId, sessionToken: await this.database.createSession(userId, 'bifrost-web') };
  }

  async providerAuthorizationUrl(userId: string, providerId: ProviderId): Promise<string> {
    const provider = findProvider(providerId);
    const { state, verifier, challenge } = createPkce();
    await this.coordinator.setEphemeral(`oauth:state:${state}`, JSON.stringify({ userId, providerId, verifier, returnTo: '/' }), OAUTH_STATE_TTL_SECONDS);
    const query = new URLSearchParams({
      client_id: this.providerClientId(providerId), redirect_uri: this.providerRedirectUri(providerId),
      response_type: 'code', state, code_challenge: challenge, code_challenge_method: 'S256',
    });
    if (providerId === 'slack') query.set('user_scope', provider.scopes.join(','));
    else query.set('scope', provider.scopes.join(' '));
    return `${provider.authorizationUrl}?${query.toString()}`;
  }

  async finishProvider(code: string, state: string): Promise<{ userId: string; providerId: ProviderId }> {
    const storedState = await this.takeState(state);
    if (!storedState.userId || !storedState.providerId) throw new Error('OAuth state is not a provider connection state');
    const provider = findProvider(storedState.providerId);
    const tokenResponse = await this.exchangeProviderToken(provider, new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: this.providerRedirectUri(provider.id), code_verifier: storedState.verifier,
    }));
    await this.database.saveCredential(storedState.userId, provider.id, normalizeCredential(tokenResponse));
    return { userId: storedState.userId, providerId: provider.id };
  }

  async accessToken(userId: string, providerId: ProviderId): Promise<string> {
    const credential = await this.database.getCredential(userId, providerId);
    if (!credential) throw new ReconnectRequiredError(providerId);
    if (!credential.expiresAt || credential.expiresAt.getTime() > Date.now() + EXPIRY_SKEW_MS) return credential.accessToken;
    return this.coordinator.withLock(`oauth-refresh:${providerId}:${userId}`, async () => {
      const latest = await this.database.getCredential(userId, providerId);
      if (!latest) throw new ReconnectRequiredError(providerId);
      if (!latest.expiresAt || latest.expiresAt.getTime() > Date.now() + EXPIRY_SKEW_MS) return latest.accessToken;
      if (!latest.refreshToken) throw new ReconnectRequiredError(providerId);
      try {
        const provider = findProvider(providerId);
        const refreshed = normalizeCredential(await this.exchangeProviderToken(provider, new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: latest.refreshToken,
        })), latest.refreshToken);
        await this.database.saveCredential(userId, providerId, refreshed);
        return refreshed.accessToken;
      } catch {
        throw new ReconnectRequiredError(providerId);
      }
    });
  }

  private async exchangeProviderToken(provider: ProviderDefinition, parameters: URLSearchParams): Promise<z.infer<typeof tokenResponseSchema>> {
    parameters.set('client_id', this.providerClientId(provider.id));
    parameters.set('client_secret', this.providerClientSecret(provider.id));
    const response = await fetch(provider.tokenUrl, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: parameters,
    });
    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!response.ok || !parsed.success || parsed.data.error) throw new Error(`${provider.displayName} token exchange failed; reconnect provider`);
    return parsed.data;
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

function createPkce(): { state: string; verifier: string; challenge: string } {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { state, verifier, challenge };
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
