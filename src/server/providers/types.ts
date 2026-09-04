export type ProviderId = 'github' | 'linear' | 'sentry' | 'slack' | 'notion' | 'granola';
export type ToolMutability = 'read' | 'write';

export type ProviderRequestContext = {
  accessToken: string;
  signal: AbortSignal;
};

type StaticProviderOAuth = {
  kind: 'static';
  authorizationUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
};

type DynamicProviderOAuth = {
  kind: 'dynamic';
  issuer: string;
  discoveryAlgorithm: 'oidc' | 'oauth2';
  authorizationUrl: string;
  tokenUrl: string;
  resource: string;
  scopes: readonly string[];
};

type ProviderOAuth = StaticProviderOAuth | DynamicProviderOAuth;

export type ProviderDefinition = {
  id: ProviderId;
  prefix: `${ProviderId}_`;
  displayName: string;
  mcpUrl: string;
  oauth: ProviderOAuth;
  /**
   * Reads back the handle the user just authorized as, so Integrations can name
   * the real account instead of guessing. When provided, it is called once
   * after the token exchange; a failure must never fail the connection itself.
   */
  readAccountLabel?: (accessToken: string, signal: AbortSignal) => Promise<string>;
};

export type ProviderMount = {
  providerId: ProviderId;
  isMounted: boolean;
  error?: string;
};
