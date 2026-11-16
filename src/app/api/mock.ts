import { providerCatalog } from './catalog';
import type {
  AdminToolProvider,
  BifrostApi,
  ProviderId,
  ConnectedClient,
  Provider,
  QueryCacheHint,
  ToolMutability,
} from './types';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const mockCacheHint: QueryCacheHint = { state: 'fresh', freshForMs: HOUR_MS, nextCheckInMs: HOUR_MS };
function daysBeforeNow(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function daysAfterNow(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

/**
 * Design-preview fixture. It uses real MCP tool names so the preview cannot
 * show tools that do not exist.
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
  sentry: [
    ['sentry_search_issues', 'Search issues', 'read'],
    ['sentry_get_issue_details', 'Get issue details', 'read'],
    ['sentry_get_trace_details', 'Get trace details', 'read'],
    ['sentry_find_projects', 'Find projects', 'read'],
    ['sentry_update_issue', 'Update issue', 'write'],
  ],
  notion: [
    ['notion_search', 'Search workspace', 'read'],
    ['notion_fetch', 'Fetch page', 'read'],
    ['notion_create_pages', 'Create pages', 'write'],
    ['notion_update_page', 'Update page', 'write'],
  ],
  slack: [
    ['slack_search_messages', 'Search messages', 'read'],
    ['slack_read_channel_history', 'Read channel history', 'read'],
    ['slack_get_thread', 'Get thread', 'read'],
    ['slack_list_channels', 'List channels', 'read'],
    ['slack_post_message', 'Post message', 'write'],
  ],
  granola: [
    ['granola_query_granola_meetings', 'Query meetings', 'read'],
    ['granola_list_meetings', 'List meetings', 'read'],
    ['granola_get_meetings', 'Get meetings', 'read'],
    ['granola_get_meeting_transcript', 'Get meeting transcript', 'read'],
  ],
};

let mockProviders: Provider[] = providerCatalog.map((provider) => ({
  ...structuredClone(provider),
  tools: (mockTools[provider.id] ?? []).map(([name, title, mutability]) => ({
    name,
    title,
    description: `${title}.`,
    mutability,
    isEnabled: mutability === 'read',
  })),
}));
const mockAdminProviders = new Map<ProviderId, AdminToolProvider>(
  mockProviders.map((provider) => [
    provider.id,
    {
      providerId: provider.id,
      status: 'ready' as const,
      rule: { isAvailable: true },
      tools: provider.tools.map((tool) => ({
        ...tool,
        upstreamName: tool.name.replace(`${provider.id}_`, ''),
        fingerprint: tool.name.padEnd(64, '0').slice(0, 64),
        state: tool.isEnabled ? 'allowed_default_on' : 'blocked',
        needsReview: !tool.isEnabled,
        review: tool.isEnabled ? { kind: 'approved' } : { kind: 'new' },
        annotations: tool.mutability === 'read' ? { readOnlyHint: true } : {},
        inputSchema: { type: 'object', properties: {} },
        autoProbability: null,
        isUncertain: false,
      })),
    } satisfies AdminToolProvider,
  ]),
);
let mockClients: ConnectedClient[] = [
  {
    id: 'web',
    kind: 'browser',
    name: 'Bifrost web',
    monogram: 'BW',
    isCurrent: true,
    firstConnectedAt: daysBeforeNow(65),
    lastUsedAt: daysBeforeNow(0),
    expiresAt: daysAfterNow(29),
    health: 'healthy',
  },
  {
    id: 'cc',
    kind: 'agent',
    name: 'Claude Code',
    monogram: '>_',
    logo: 'claude-code',
    isCurrent: false,
    firstConnectedAt: daysBeforeNow(65),
    lastUsedAt: daysBeforeNow(0.0014),
    health: 'healthy',
  },
  {
    id: 'cur',
    kind: 'agent',
    name: 'Cursor',
    monogram: 'Cu',
    logo: 'cursor',
    isCurrent: false,
    firstConnectedAt: daysBeforeNow(110),
    lastUsedAt: daysBeforeNow(12),
    health: 'healthy',
  },
];

export const mockApi: BifrostApi = {
  getProviders: async () => ({ data: structuredClone(mockProviders), cache: mockCacheHint }),
  startProviderConnection: async (providerId) => {
    mockProviders = mockProviders.map((provider) =>
      provider.id === providerId
        ? { ...provider, status: 'connected', tools: provider.tools.map((tool) => ({ ...tool, isEnabled: true })) }
        : provider,
    );
  },
  disconnectProvider: async (providerId) => {
    mockProviders = mockProviders.map((provider) =>
      provider.id === providerId
        ? {
            ...provider,
            status: 'not-connected',
            isHidden: false,
            tools: provider.tools.map((tool) => ({ ...tool, isEnabled: false })),
          }
        : provider,
    );
  },
  setProviderHidden: async (providerId, isHidden) => {
    mockProviders = mockProviders.map((provider) =>
      provider.id === providerId ? { ...provider, isHidden } : provider,
    );
  },
  setToolEnabled: async (toolName, isEnabled) => {
    mockProviders = mockProviders.map((provider) => ({
      ...provider,
      tools: provider.tools.map((tool) => (tool.name === toolName ? { ...tool, isEnabled } : tool)),
    }));
  },
  getAdminProviderTools: async (providerId) => ({
    data: structuredClone(mockAdminProviders.get(providerId)!),
    cache: mockCacheHint,
  }),
  refreshAdminProviderTools: async (providerId) => ({
    data: structuredClone(mockAdminProviders.get(providerId)!),
    cache: mockCacheHint,
  }),
  setToolPolicies: async ({ providerId, tools }) => {
    const provider = mockAdminProviders.get(providerId)!;
    const stateByName = new Map(tools.map((tool) => [tool.toolName, tool.state]));
    mockAdminProviders.set(providerId, {
      ...provider,
      tools: provider.tools.map((tool) =>
        stateByName.has(tool.name)
          ? {
              ...tool,
              state: stateByName.get(tool.name)!,
              needsReview: false,
              review: { kind: 'approved' },
              autoProbability: null,
              isUncertain: false,
            }
          : tool,
      ),
    });
    return mockCacheHint;
  },
  // No classifier in the preview: saving only records the wording.
  setAutomaticToolRule: async (providerId, instructions) => {
    const provider = mockAdminProviders.get(providerId)!;
    mockAdminProviders.set(providerId, {
      ...provider,
      rule: {
        isAvailable: true,
        instructions,
        revision: (provider.rule.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      },
    });
    return 'applied';
  },
  clearAutomaticToolRule: async (providerId) => {
    const provider = mockAdminProviders.get(providerId)!;
    mockAdminProviders.set(providerId, { ...provider, rule: { isAvailable: true } });
  },
  getConnectedClients: async () => structuredClone(mockClients),
  renewClient: async (client) => {
    mockClients = mockClients.map((entry) =>
      entry.id === client.id ? { ...entry, health: 'healthy', expiresAt: daysAfterNow(30) } : entry,
    );
  },
  revokeClient: async (client) => {
    mockClients = mockClients.filter((entry) => entry.id !== client.id);
  },
  // No server behind the preview, so the exact host does not matter and
  // failing would just blank the page.
  getMcpAddress: async () => `${window.location.origin}/mcp`,
};
