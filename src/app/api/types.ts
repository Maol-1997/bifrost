/**
 * Everything the screens can see. Server responses are typed here too, so
 * the live and mock implementations describe the same shapes.
 */
export type ProviderId = 'github' | 'linear' | 'sentry' | 'slack' | 'notion' | 'granola';
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
  /** Discovery failed for a connected provider, so an empty tool list is not authoritative. */
  toolDiscoveryFailed: boolean;
};

export type ToolPolicyState = 'blocked' | 'allowed_default_off' | 'allowed_default_on';
type ToolCacheState = 'fresh' | 'revalidating' | 'refresh_failed';
export type ToolContractChange =
  | { kind: 'added'; path: string; after: unknown }
  | { kind: 'removed'; path: string; before: unknown }
  | { kind: 'changed'; path: string; before: unknown; after: unknown };
export type ToolContractReview =
  | { kind: 'approved' }
  | { kind: 'new' }
  | { kind: 'changed'; changes: null }
  | { kind: 'changed'; changes: readonly ToolContractChange[]; truncated: boolean };

export type QueryCacheHint = {
  state: ToolCacheState;
  freshForMs: number;
  nextCheckInMs: number;
};

export type CachedResult<Value> = {
  data: Value;
  cache: QueryCacheHint;
};

export type AdminTool = {
  name: string;
  upstreamName: string;
  title: string;
  description: string;
  mutability: ToolMutability;
  fingerprint: string;
  state: ToolPolicyState;
  needsReview: boolean;
  review: ToolContractReview;
  /** Set when the provider's automatic rule decided the current definition. */
  autoProbability: number | null;
  isUncertain: boolean;
  annotations: Readonly<Record<string, unknown>>;
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema?: Readonly<Record<string, unknown>> | undefined;
};

export type AutomaticToolRule = {
  /** False when the server has no OPENROUTER_API_KEY, so no rule can run. */
  isAvailable: boolean;
  instructions?: string | undefined;
  revision?: number | undefined;
  updatedAt?: string | undefined;
};

export type AutomaticRuleClassification = 'applied' | 'not-configured' | 'no-rule' | 'busy' | 'backing-off' | 'not-connected' | 'failed';

export type AdminToolProvider = {
  providerId: ProviderId;
  status: 'ready' | 'not-connected' | 'error';
  tools: readonly AdminTool[];
  rule: AutomaticToolRule;
};

export type ToolPolicyChange = {
  providerId: ProviderId;
  toolName: string;
  fingerprint: string;
  state: ToolPolicyState;
};

export type ToolPolicyBatchChange = {
  providerId: ProviderId;
  tools: readonly Omit<ToolPolicyChange, 'providerId'>[];
};

/**
 * `browser` is a signed-in tab; `agent` is a program holding an OAuth grant.
 * They are separate records server-side, so the kind travels with the id and
 * decides which one an action applies to.
 */
type ClientKind = 'browser' | 'agent';

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
  logo?: ClientLogoId | undefined;
  /** True for the session making this request, so the UI can say "this browser". */
  isCurrent: boolean;
  firstConnectedAt: string;
  lastUsedAt: string;
  /** Browser sessions only. An agent renews itself, so it has no expiry to show. */
  expiresAt?: string | undefined;
  health: ClientHealth;
};

export type AppHealth = {
  appId: ProviderId;
  health: SystemHealth;
  /** The vendor's public status page, so a worried user can read the source. */
  statusUrl: string;
  incidentTitle?: string | undefined;
  /** ISO start of the open incident; absent while the app is operational. */
  since?: string | undefined;
  /** ISO resolution of the vendor's last incident; absent when their feed has no history. */
  quietSince?: string | undefined;
};

export type HealthSnapshot = { checkedAt: string; apps: readonly AppHealth[] };

export type CurrentUser = { name: string; email: string; isAdmin: boolean };

export type SignInPolicy = { allowedDomains: readonly string[]; isRestricted: boolean };

/**
 * The operations that behave differently in the design preview than against
 * the server. Chosen once, in `bifrost.ts`; nothing else branches on the mode.
 */
export type BifrostApi = {
  getProviders: () => Promise<CachedResult<readonly Provider[]>>;
  startProviderConnection: (providerId: ProviderId) => Promise<void>;
  disconnectProvider: (providerId: ProviderId) => Promise<void>;
  setProviderHidden: (providerId: ProviderId, isHidden: boolean) => Promise<void>;
  setToolEnabled: (toolName: string, isEnabled: boolean) => Promise<void>;
  getAdminProviderTools: (providerId: ProviderId) => Promise<CachedResult<AdminToolProvider>>;
  refreshAdminProviderTools: (providerId: ProviderId) => Promise<CachedResult<AdminToolProvider>>;
  setToolPolicies: (change: ToolPolicyBatchChange) => Promise<QueryCacheHint>;
  setAutomaticToolRule: (providerId: ProviderId, instructions: string) => Promise<AutomaticRuleClassification>;
  clearAutomaticToolRule: (providerId: ProviderId) => Promise<void>;
  getConnectedClients: () => Promise<readonly ConnectedClient[]>;
  renewClient: (client: ConnectedClient) => Promise<void>;
  revokeClient: (client: ConnectedClient) => Promise<void>;
  getMcpAddress: () => Promise<string>;
};
