export type ProviderId = 'github' | 'linear' | 'slack';
export type ToolMutability = 'read' | 'write';

export type ProviderRequestContext = {
  accessToken: string;
  signal: AbortSignal;
};

export type ProviderDefinition = {
  id: ProviderId;
  prefix: `${ProviderId}_`;
  displayName: string;
  mcpUrl: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  /**
   * Reads back the handle the user just authorized as, so Integrations can name
   * the real account instead of guessing. Called once, right after the token
   * exchange; a failure here must never fail the connection itself.
   */
  readAccountLabel: (accessToken: string, signal: AbortSignal) => Promise<string>;
};

export type ProviderMount = {
  providerId: ProviderId;
  isMounted: boolean;
  error?: string;
};
