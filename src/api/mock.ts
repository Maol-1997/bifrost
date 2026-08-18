import { providerCatalog } from './catalog';
import type { BifrostApi, ConnectedClient, Provider, ToolMutability } from './types';

const DAY_MS = 86_400_000;
function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/**
 * Design-preview fixture, using the real MCP tool names on purpose. A preview
 * built on invented tools is how this screen drifted into fiction the first time.
 */
const mockTools: Readonly<Record<string, readonly [string, string, ToolMutability][]>> = {
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
  tools: (mockTools[provider.id] ?? []).map(([name, title, mutability]) => ({
    name, title, description: `${title}.`, mutability, isEnabled: mutability === 'read', isBlockedByServer: false,
  })),
}));
let mockClients: ConnectedClient[] = [
  { id: 'web', kind: 'browser', name: 'Bifrost web', monogram: 'BW', isCurrent: true, firstConnectedAt: daysAgo(65), lastUsedAt: daysAgo(0), expiresAt: daysAgo(-29), health: 'healthy' },
  { id: 'cc', kind: 'agent', name: 'Claude Code', monogram: '>_', logo: 'claude-code', isCurrent: false, firstConnectedAt: daysAgo(65), lastUsedAt: daysAgo(0.0014), health: 'healthy' },
  { id: 'cur', kind: 'agent', name: 'Cursor', monogram: 'Cu', logo: 'cursor', isCurrent: false, firstConnectedAt: daysAgo(110), lastUsedAt: daysAgo(12), health: 'healthy' },
];

/** The design preview: same screens, in-memory state, no server. */
export const mockApi: BifrostApi = {
  getProviders: async () => structuredClone(mockProviders),
  startProviderConnection: async (providerId) => {
    mockProviders = mockProviders.map((provider) => provider.id === providerId ? { ...provider, status: 'connected', tools: provider.tools.map((tool) => ({ ...tool, isEnabled: true })) } : provider);
  },
  disconnectProvider: async (providerId) => {
    mockProviders = mockProviders.map((provider) => provider.id === providerId ? { ...provider, status: 'not-connected', isHidden: false, tools: provider.tools.map((tool) => ({ ...tool, isEnabled: false })) } : provider);
  },
  setProviderHidden: async (providerId, isHidden) => {
    mockProviders = mockProviders.map((provider) => provider.id === providerId ? { ...provider, isHidden } : provider);
  },
  setToolEnabled: async (toolName, isEnabled) => {
    mockProviders = mockProviders.map((provider) => ({ ...provider, tools: provider.tools.map((tool) => tool.name === toolName ? { ...tool, isEnabled } : tool) }));
  },
  getConnectedClients: async () => structuredClone(mockClients),
  renewClient: async (client) => {
    mockClients = mockClients.map((entry) => entry.id === client.id ? { ...entry, health: 'healthy', expiresAt: daysAgo(-30) } : entry);
  },
  revokeClient: async (client) => {
    mockClients = mockClients.filter((entry) => entry.id !== client.id);
  },
  // No server behind the preview, so the exact host does not matter and
  // failing would just blank the page.
  getMcpAddress: async () => `${window.location.origin}/mcp`,
};
