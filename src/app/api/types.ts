/**
 * Everything the screens can see. Server responses are typed here too, so
 * the live and mock implementations describe the same shapes.
 */
export type ProviderId = 'github' | 'linear' | 'slack' | 'notion';
/** Notion is catalog-only: it renders as a card but has no server-side provider to connect to. */
export type ConnectableProviderId = Exclude<ProviderId, 'notion'>;
export type ConnectionStatus = 'connected' | 'needs-reconnect' | 'not-connected' | 'unavailable';
export type ToolMutability = 'read' | 'write';
export type ClientHealth = 'healthy' | 'needs-renewal';
/** `unknown` means the vendor's own status page was unreachable, not that they are fine. */
export type SystemHealth = 'operational' | 'degraded' | 'down' | 'unknown';

export type ProviderTool = {
  /** The MCP name the agent actually calls, e.g. `github_get_pull_request`. */
  name: string;
  title: string;
  description: string;
  mutability: ToolMutability;
  isEnabled: boolean;
  /** Off because the deployment forbids it, so the switch cannot help. */
  isBlockedByServer: boolean;
};

export type Provider = {
  id: ProviderId;
  name: string;
  monogram: string;
  description: string;
  status: ConnectionStatus;
  isHidden: boolean;
  /** ISO timestamp of the OAuth grant; absent until the provider is connected. */
  connectedAt?: string;
  /** The handle the user authorized as, read back from the provider. */
  accountLabel?: string;
  permissions: readonly string[];
  neverPermission: string;
  tools: readonly ProviderTool[];
  successCapabilities: readonly string[];
};

/**
 * `browser` is a signed-in tab; `agent` is a program holding an OAuth grant.
 * They are separate records server-side, so the kind travels with the id and
 * decides which one an action applies to.
 */
export type ClientKind = 'browser' | 'agent';

/**
 * Clients we ship a brand mark for. Mirrors `ClientLogoId` in
 * `src/server/clients/describe.ts`, which is where a client gets matched to one; the
 * two halves of the app do not share a module, so the union is written twice.
 */
export type ClientLogoId = 'claude-code' | 'codex' | 'cursor' | 'opencode';

export type ConnectedClient = {
  id: string;
  kind: ClientKind;
  name: string;
  monogram: string;
  /** Absent for a client with no mark of its own, which then shows its monogram. */
  logo?: ClientLogoId;
  /** True for the session making this request, so the UI can say "this browser". */
  isCurrent: boolean;
  firstConnectedAt: string;
  lastUsedAt: string;
  /** Browser sessions only. An agent renews itself, so it has no expiry to show. */
  expiresAt?: string;
  health: ClientHealth;
};

export type AppHealth = {
  appId: ProviderId;
  health: SystemHealth;
  /** The vendor's public status page, so a worried user can read the source. */
  statusUrl: string;
  incidentTitle?: string;
  /** ISO start of the open incident; absent while the app is operational. */
  since?: string;
  /** ISO resolution of the vendor's last incident; absent when their feed has no history. */
  quietSince?: string;
};

export type HealthSnapshot = { checkedAt: string; apps: readonly AppHealth[] };

export type CurrentUser = { name: string; email: string };

export type SignInPolicy = { allowedDomains: readonly string[]; isRestricted: boolean };

export type StatusResponse = {
  providers: readonly { id: string; name: string; isMounted: boolean; toolCount: number; error?: string }[];
};

export type ConnectionsResponse = {
  apps: readonly {
    providerId: 'github' | 'linear' | 'slack';
    isConnected: boolean;
    isHidden: boolean;
    needsReconnect: boolean;
    tools: readonly { name: string; title: string; description: string; mutability: ToolMutability; isEnabled: boolean; isBlockedByServer: boolean }[];
    connectedAt?: string;
    accountLabel?: string;
  }[];
};

/**
 * The operations that behave differently in the design preview than against
 * the server. Chosen once, in `bifrost.ts`; nothing else branches on the mode.
 */
export type BifrostApi = {
  getProviders: () => Promise<readonly Provider[]>;
  startProviderConnection: (providerId: ConnectableProviderId) => Promise<void>;
  disconnectProvider: (providerId: ProviderId) => Promise<void>;
  setProviderHidden: (providerId: ProviderId, isHidden: boolean) => Promise<void>;
  setToolEnabled: (toolName: string, isEnabled: boolean) => Promise<void>;
  getConnectedClients: () => Promise<readonly ConnectedClient[]>;
  renewClient: (client: ConnectedClient) => Promise<void>;
  revokeClient: (client: ConnectedClient) => Promise<void>;
  getMcpAddress: () => Promise<string>;
};
