import { APP_ROUTES } from '@/lib/routes';

export type ProviderId = 'github' | 'linear' | 'slack' | 'notion';
/** Notion is catalog-only: it renders as a card but has no server-side provider to connect to. */
export type ConnectableProviderId = Exclude<ProviderId, 'notion'>;
export type ConnectionStatus = 'connected' | 'needs-reconnect' | 'not-connected' | 'unavailable';
export type ToolKind = 'read' | 'write';
export type ClientHealth = 'healthy' | 'needs-renewal';
/** `unknown` means the vendor's own status page was unreachable, not that they are fine. */
export type SystemHealth = 'operational' | 'degraded' | 'down' | 'unknown';

export type ProviderTool = {
  /** The MCP name the agent actually calls, e.g. `github_get_pull_request`. */
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
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
 * `src/clients/describe.ts`, which is where a client gets matched to one; the
 * two halves of the app do not share a module, so the union is written twice.
 */
export type ClientLogoId = 'claude-code' | 'codex' | 'cursor' | 'opencode';

export type ClientSession = {
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

/** Public and pre-auth: the sign-in screen must state the real rule, not a slogan. */
export async function getSignInPolicy(): Promise<SignInPolicy> {
  return fetchJson<SignInPolicy>('/api/sign-in-policy.json');
}

type StatusResponse = {
  providers: readonly { id: string; name: string; isMounted: boolean; toolCount: number; error?: string }[];
};

type ConnectionsResponse = {
  apps: readonly {
    providerId: 'github' | 'linear' | 'slack';
    isConnected: boolean;
    isHidden: boolean;
    needsReconnect: boolean;
    tools: readonly { name: string; title: string; description: string; mutability: ToolKind; isEnabled: boolean; isBlockedByServer: boolean }[];
    connectedAt?: string;
    accountLabel?: string;
  }[];
};

/**
 * The curated prose the screens need: what an app is, and what connecting it
 * actually lets your agents do.
 *
 * Carries no tools on purpose. Every claim below is checked against the tools
 * the server really registers, because this text is the promise a user reads
 * before handing over access — an aspirational version of it is a lie, not a
 * placeholder. `neverPermission` says "Bifrost has no tool that does" rather
 * than "it cannot": the OAuth scopes are broader than the tools, and the tool
 * surface is the boundary that is actually enforced.
 */
const providerCatalog: readonly Omit<Provider, 'tools'>[] = [
  {
    id: 'github', name: 'GitHub', monogram: 'G', description: "Where your team's code and code reviews live.", status: 'connected', isHidden: false,
    permissions: ['Read pull requests, their diffs and their review comments', 'See whether CI checks passed', 'Comment on an issue or pull request as you'],
    neverPermission: 'Your agents can never push code, merge, create branches or pull requests, or change settings — Bifrost has no tool that does.',
    successCapabilities: ['Read pull requests, diffs and review comments', 'Check whether CI passed', 'Comment on issues and pull requests — in your name'],
  },
  {
    id: 'linear', name: 'Linear', monogram: 'L', description: 'Where projects and tasks are tracked.', status: 'needs-reconnect', isHidden: false,
    permissions: ['Search and read issues, and list your teams and projects', 'Create issues and post comments as you'],
    neverPermission: 'Your agents can never edit or delete an existing issue, or change workspace settings — Bifrost has no tool that does.',
    successCapabilities: ['Search and read issues, teams and projects', 'Create issues and comments — in your name'],
  },
  {
    id: 'slack', name: 'Slack', monogram: 'S', description: 'Where the team talks.', status: 'not-connected', isHidden: false,
    permissions: ['List channels and read their history, threads included', 'Search messages you can already see', 'Post a message as you'],
    neverPermission: 'Your agents can never read your direct messages, join channels, or delete anything — Bifrost has no tool that does.',
    successCapabilities: ['List channels and read history and threads', 'Search messages you can already see', 'Post messages — in your name'],
  },
  {
    id: 'notion', name: 'Notion', monogram: 'N', description: 'Where docs and notes live.', status: 'unavailable', isHidden: false,
    permissions: ['Nothing yet — Bifrost has no Notion tools'],
    neverPermission: 'Connecting it is not possible yet, so it grants nothing.',
    successCapabilities: [],
  },
] as const;

const DAY_MS = 86_400_000;
function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/**
 * Design-preview fixture, using the real MCP tool names on purpose. A preview
 * built on invented tools is how this screen drifted into fiction the first time.
 */
const mockTools: Readonly<Record<string, readonly [string, string, ToolKind][]>> = {
  github: [
    ['github_list_pull_requests', 'List pull requests', 'read'],
    ['github_get_pull_request', 'Get pull request', 'read'],
    ['github_get_pull_request_diff', 'Get pull request diff', 'read'],
    ['github_list_review_comments', 'List review comments', 'read'],
    ['github_list_check_runs', 'List check runs', 'read'],
    ['github_create_issue_comment', 'Create issue comment', 'write'],
  ],
  linear: [
    ['linear_search_issues', 'Search issues', 'read'],
    ['linear_get_issue', 'Get issue', 'read'],
    ['linear_list_my_issues', 'List my issues', 'read'],
    ['linear_list_teams_projects', 'List teams and projects', 'read'],
    ['linear_create_issue', 'Create issue', 'write'],
    ['linear_add_comment', 'Add comment', 'write'],
  ],
  slack: [
    ['slack_search_messages', 'Search messages', 'read'],
    ['slack_read_channel_history', 'Read channel history', 'read'],
    ['slack_get_thread', 'Get thread', 'read'],
    ['slack_list_channels', 'List channels', 'read'],
    ['slack_post_message', 'Post message', 'write'],
  ],
};

let mockProviders: Provider[] = providerCatalog.map((provider) => ({
  ...structuredClone(provider),
  tools: (mockTools[provider.id] ?? []).map(([name, title, kind]) => ({
    name, title, description: `${title}.`, kind, isEnabled: kind === 'read', isBlockedByServer: false,
  })),
}));
let mockClients: ClientSession[] = [
  { id: 'web', kind: 'browser', name: 'Bifrost web', monogram: 'BW', isCurrent: true, firstConnectedAt: daysAgo(65), lastUsedAt: daysAgo(0), expiresAt: daysAgo(-29), health: 'healthy' },
  { id: 'cc', kind: 'agent', name: 'Claude Code', monogram: '>_', logo: 'claude-code', isCurrent: false, firstConnectedAt: daysAgo(65), lastUsedAt: daysAgo(0.0014), health: 'healthy' },
  { id: 'cur', kind: 'agent', name: 'Cursor', monogram: 'Cu', logo: 'cursor', isCurrent: false, firstConnectedAt: daysAgo(110), lastUsedAt: daysAgo(12), health: 'healthy' },
];

function isMockMode(): boolean {
  return import.meta.env.VITE_USE_MOCK_API === 'true';
}

async function fetchJson<Response>(path: string, options?: RequestInit): Promise<Response> {
  const response = await fetch(path, options);
  if (response.status === 401) {
    window.location.assign(APP_ROUTES.signIn);
    throw new Error('Authentication required');
  }
  if (!response.ok) throw new Error(`Bifrost request failed with status ${response.status}`);
  return response.json() as Promise<Response>;
}

/**
 * Who is signed in, or `undefined` when nobody is.
 *
 * Deliberately does not go through `fetchJson`: a 401 here must not bounce the
 * visitor to sign-in, because Service status is public and has to stay readable
 * when you cannot log in — which is exactly when you need it.
 */
export async function getCurrentUser(): Promise<CurrentUser | undefined> {
  const response = await fetch('/api/me.json');
  if (response.status === 401) return undefined;
  if (!response.ok) throw new Error(`Bifrost request failed with status ${response.status}`);
  return response.json() as Promise<CurrentUser>;
}

export function isConnectableProvider(providerId: ProviderId): providerId is ConnectableProviderId {
  return providerId !== 'notion';
}

export async function getProviders(): Promise<readonly Provider[]> {
  if (isMockMode()) return structuredClone(mockProviders);
  const [status, connections] = await Promise.all([
    fetchJson<StatusResponse>('/api/status.json'),
    fetchJson<ConnectionsResponse>('/api/app-connections.json'),
  ]);
  const mountById = new Map(status.providers.map((provider) => [provider.id, provider]));
  const connectionById = new Map(connections.apps.map((connection) => [connection.providerId, connection]));
  return providerCatalog.map((provider) => {
    const mount = mountById.get(provider.id);
    const connection = isConnectableProvider(provider.id) ? connectionById.get(provider.id) : undefined;
    return {
      ...provider,
      status: deriveConnectionStatus(provider.id, mount, connection),
      isHidden: connection?.isHidden ?? false,
      ...(connection?.connectedAt ? { connectedAt: connection.connectedAt } : {}),
      ...(connection?.accountLabel ? { accountLabel: connection.accountLabel } : {}),
      // Straight from the server. The enabled state is the server's answer too,
      // never re-derived from the connection status: doing that is what used to
      // wipe every choice on reload.
      tools: (connection?.tools ?? []).map((tool) => ({
        name: tool.name, title: tool.title, description: tool.description,
        kind: tool.mutability, isEnabled: tool.isEnabled, isBlockedByServer: tool.isBlockedByServer,
      })),
    };
  });
}

/**
 * Server facts win in this order: an unmounted provider is unavailable no
 * matter what the user connected; a connection decides between connected and
 * needs-reconnect; with neither, only Notion (no server-side provider) is
 * unavailable rather than merely not connected.
 */
function deriveConnectionStatus(
  providerId: ProviderId,
  mount: StatusResponse['providers'][number] | undefined,
  connection: ConnectionsResponse['apps'][number] | undefined,
): ConnectionStatus {
  if (mount?.isMounted === false) return 'unavailable';
  if (connection?.isConnected) return connection.needsReconnect ? 'needs-reconnect' : 'connected';
  return providerId === 'notion' ? 'unavailable' : 'not-connected';
}

/**
 * The prose skeleton, with no tools. Used as a first paint before the real list
 * arrives, so a screen never invents tools it cannot vouch for.
 */
export function getProviderCatalog(): readonly Provider[] {
  return providerCatalog.map((provider) => ({ ...structuredClone(provider), tools: [] }));
}

export async function connectProvider(providerId: ConnectableProviderId): Promise<void> {
  if (!isMockMode()) {
    window.location.assign(`/oauth/${providerId}/start`);
    return;
  }
  mockProviders = mockProviders.map((provider) => provider.id === providerId ? { ...provider, status: 'connected', tools: provider.tools.map((tool) => ({ ...tool, isEnabled: true })) } : provider);
}

export async function disconnectProvider(providerId: ProviderId): Promise<void> {
  if (!isMockMode() && providerId !== 'notion') {
    await fetchJson(`/api/connections/${providerId}/disconnect`, { method: 'POST' });
  }
  mockProviders = mockProviders.map((provider) => provider.id === providerId ? { ...provider, status: 'not-connected', isHidden: false, tools: provider.tools.map((tool) => ({ ...tool, isEnabled: false })) } : provider);
}

export async function setProviderHidden(providerId: ProviderId, isHidden: boolean): Promise<void> {
  if (!isMockMode() && providerId !== 'notion') {
    await fetchJson(`/api/connections/${providerId}/preference`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isHidden }) });
  }
  mockProviders = mockProviders.map((provider) => provider.id === providerId ? { ...provider, isHidden } : provider);
}

/**
 * Persists whether this user's agents get a tool.
 *
 * Keyed by the MCP tool name, which is the same string the agent calls and the
 * server registers — so there is no mapping table between what you switched off
 * and what actually stops working.
 */
export async function setToolEnabled(toolName: string, isEnabled: boolean): Promise<void> {
  if (!isMockMode()) {
    await fetchJson(`/api/tools/${toolName}/preference`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isEnabled }),
    });
    return;
  }
  mockProviders = mockProviders.map((provider) => ({ ...provider, tools: provider.tools.map((tool) => tool.name === toolName ? { ...tool, isEnabled } : tool) }));
}

export async function getClientSessions(): Promise<readonly ClientSession[]> {
  if (isMockMode()) return structuredClone(mockClients);
  const { clients } = await fetchJson<{ clients: readonly ClientSession[] }>('/api/clients.json');
  return clients;
}

export async function renewClient(client: ClientSession): Promise<void> {
  if (!isMockMode()) {
    await fetchJson(`/api/clients/${client.kind}/${client.id}/renew`, { method: 'POST' });
    return;
  }
  mockClients = mockClients.map((entry) => entry.id === client.id ? { ...entry, health: 'healthy', expiresAt: daysAgo(-30) } : entry);
}

export async function revokeClient(client: ClientSession): Promise<void> {
  if (!isMockMode()) {
    const { wasCurrentClient } = await fetchJson<{ wasCurrentClient: boolean }>(`/api/clients/${client.kind}/${client.id}/revoke`, { method: 'POST' });
    // Revoking the session you are browsing with is a sign-out; staying on the
    // page would show a logged-in shell backed by a dead cookie.
    if (wasCurrentClient) window.location.assign(APP_ROUTES.signIn);
    return;
  }
  mockClients = mockClients.filter((entry) => entry.id !== client.id);
}

/**
 * Deliberately has no mock branch. Vendor uptime is public and identical for
 * every user, so a fake here would only ever be a lie on the one screen whose
 * entire job is telling the truth about whether GitHub is down.
 */
export async function getAppHealth(): Promise<HealthSnapshot> {
  return fetchJson<HealthSnapshot>('/api/provider-health.json');
}

/**
 * The address to give a client, read from the very document that client will
 * read to discover how to authenticate.
 *
 * Deliberately not `window.location.origin`: behind the dev proxy that is port
 * 5173, while the OAuth issuer and the audience stamped into every token are the
 * server's own `PUBLIC_URL`. Sourcing it here means the address on screen cannot
 * drift from the one the flow actually works against.
 */
export async function getMcpAddress(): Promise<string> {
  // The mock branch is a design preview with no server behind it, so the exact
  // host does not matter and failing would just blank the page.
  if (isMockMode()) return `${window.location.origin}/mcp`;
  const { resource } = await fetchJson<{ resource: string }>('/.well-known/oauth-protected-resource/mcp');
  return resource;
}

/**
 * Answers "has a real MCP client reached Bifrost?" for the setup screen.
 * The web session does not count — it is the browser the user is already in.
 */
export async function checkClientConnection(): Promise<ClientSession | undefined> {
  const clients = await getClientSessions();
  return clients.find((client) => client.kind === 'agent');
}
