import { describe, expect, it, vi } from 'vitest';
import type { OAuthService } from '../src/server/oauth.js';
import { createInMemoryToolCacheStore } from '../src/server/tools/cache-store.js';
import { ToolDiscoveryService } from '../src/server/tools/discovery.js';

const listUpstreamTools = vi.hoisted(() => vi.fn());

vi.mock('../src/server/providers/mcp-client.js', () => ({ listUpstreamTools }));
vi.mock('../src/server/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  errorSummary: (error: unknown) => ({ error }),
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('upstream tool listing normalization', () => {
  it('keeps the first definition when a provider publishes the same name twice', async () => {
    listUpstreamTools.mockResolvedValue([
      { name: 'get_issue', description: 'first', inputSchema: { type: 'object' } },
      { name: 'get_issue', description: 'second', inputSchema: { type: 'object' } },
      { name: 'list_issues', description: 'other', inputSchema: { type: 'object' } },
    ]);
    const discovery = new ToolDiscoveryService({
      oauth: { getOrRefreshAccessToken: vi.fn(async () => 'token') } as unknown as OAuthService,
      mounts: [{ providerId: 'github', isMounted: true }],
      store: createInMemoryToolCacheStore(),
    });

    const result = await discovery.discoverProviderFresh({ userId: USER_ID, providerId: 'github' });

    expect(result.tools.map((tool) => [tool.name, tool.description])).toEqual([
      ['github_get_issue', 'first'],
      ['github_list_issues', 'other'],
    ]);
  });
});
