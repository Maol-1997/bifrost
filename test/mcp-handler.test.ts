import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/server/config.js';
import type { Coordinator } from '../src/server/coordination.js';
import type { Database } from '../src/server/database/index.js';
import { createHumanMcpHandler } from '../src/server/mcp.js';
import type { OAuthService } from '../src/server/oauth.js';
import { PROVIDER_REGISTRY } from '../src/server/providers/registry.js';
import { normalizeUpstreamTool } from '../src/server/tools/catalog.js';
import type { ToolDiscoveryService } from '../src/server/tools/discovery.js';
import { modernRequestBody, modernRequestHeaders } from './helpers/mcp-protocol.js';

vi.mock('../src/server/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  errorSummary: (error: unknown) => ({ error }),
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const github = PROVIDER_REGISTRY.find((entry) => entry.id === 'github')!;
const tools = [
  normalizeUpstreamTool(github, { name: 'get_issue', description: 'first', inputSchema: { type: 'object' } }),
  normalizeUpstreamTool(github, { name: 'get_issue', description: 'duplicate', inputSchema: { type: 'object' } }),
  normalizeUpstreamTool(github, { name: 'list_issues', description: 'other', inputSchema: { type: 'object' } }),
];

describe('per-request MCP server assembly', () => {
  it('serves the remaining tools when one cannot be registered', async () => {
    const policies = new Map(tools.map((tool) => [tool.name, { toolName: tool.name, fingerprint: tool.fingerprint, state: 'allowed_default_on' as const }]));
    const handler = createHumanMcpHandler({
      config: {} as Config,
      coordinator: {} as Coordinator,
      oauth: {} as OAuthService,
      mounts: [{ providerId: 'github', isMounted: true }],
      database: {
        userVisibilityState: async () => ({ connectedProviders: new Set(['github']), hiddenProviders: new Set(), toolPreferences: new Map() }),
        toolPolicyDecisions: async () => policies,
      } as unknown as Database,
      toolDiscovery: { discoverConnected: async () => ({ tools, failures: [], cache: { state: 'fresh' } }) } as unknown as ToolDiscoveryService,
      upstreamClients: { withClient: async () => { throw new Error('unexpected upstream call'); } },
    });
    const parsedBody = modernRequestBody(1, 'tools/list');
    const request = new Request('https://bifrost.example/mcp', {
      method: 'POST',
      headers: modernRequestHeaders(parsedBody),
      body: JSON.stringify(parsedBody),
    });

    const response = await handler.fetch(request, {
      authInfo: { token: 't', clientId: 'c', scopes: ['mcp'], extra: { userId: USER_ID } },
      parsedBody,
    });
    const body = await response.json() as { result?: { tools: { name: string }[] } };
    await handler.close();

    expect({ status: response.status, tools: body.result?.tools.map((tool) => tool.name), body })
      .toMatchObject({ status: 200, tools: ['github_get_issue', 'github_list_issues'] });
  });
});
