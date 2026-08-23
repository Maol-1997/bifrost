import type { CallToolResult } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/server/config.js';
import type { Coordinator } from '../src/server/coordination.js';
import type { Database } from '../src/server/database/index.js';
import type { OAuthService } from '../src/server/oauth.js';
import type { ToolDiscoveryService } from '../src/server/tools/discovery.js';
import { normalizeUpstreamTool } from '../src/server/tools/catalog.js';
import { executeUserTool, type ToolExecutionDependencies } from '../src/server/tools/user-toolset.js';
import { PROVIDER_REGISTRY } from '../src/server/providers/registry.js';

const upstreamCall = vi.hoisted(() => vi.fn());

vi.mock('../src/server/providers/mcp-client.js', () => ({
  callUpstreamTool: upstreamCall,
}));

const provider = PROVIDER_REGISTRY.find((entry) => entry.id === 'github')!;
const discoveredTool = normalizeUpstreamTool(provider, {
  name: 'get_issue',
  description: 'Get an issue.',
  inputSchema: { type: 'object', properties: { issueNumber: { type: 'number' } } },
});
const success: CallToolResult = { content: [{ type: 'text', text: 'Issue 42' }] };

type Harness = {
  dependencies: ToolExecutionDependencies;
  invalidateProvider: ReturnType<typeof vi.fn>;
  toolPolicies: ReturnType<typeof vi.fn>;
};

function harness(): Harness {
  const invalidateProvider = vi.fn(async () => undefined);
  const withConcurrencyLease = vi.fn(async (request: { operation: () => Promise<unknown> }) => (
    request.operation()
  ));
  const toolPolicies = vi.fn(async () => new Map([[discoveredTool.name, {
    toolName: discoveredTool.name,
    fingerprint: discoveredTool.fingerprint,
    state: 'allowed_default_on' as const,
  }]]));
  return {
    invalidateProvider,
    toolPolicies,
    dependencies: {
      config: { SLOW_TOOL_MS: Number.MAX_SAFE_INTEGER } as Config,
      database: { toolPolicies } as unknown as Database,
      coordinator: {
        enforceRateLimit: vi.fn(async () => undefined),
        withConcurrencyLease,
      } as unknown as Coordinator,
      oauth: { getOrRefreshAccessToken: vi.fn(async () => 'access-token') } as unknown as OAuthService,
      toolDiscovery: { invalidateProvider } as unknown as ToolDiscoveryService,
    },
  };
}

async function execute(dependencies: ToolExecutionDependencies): Promise<CallToolResult> {
  return executeUserTool({
    userId: '11111111-1111-4111-8111-111111111111',
    clientId: 'test-client',
    tool: discoveredTool,
    input: { issueNumber: 42 },
    dependencies,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  upstreamCall.mockResolvedValue(success);
});

describe('cached tool execution', () => {
  it('checks the current database policy before making an upstream call', async () => {
    const testHarness = harness();
    testHarness.toolPolicies.mockResolvedValue(new Map([[discoveredTool.name, {
      toolName: discoveredTool.name,
      fingerprint: '0'.repeat(64),
      state: 'allowed_default_on',
    }]]));

    const result = await execute(testHarness.dependencies);

    expect(result.isError).toBe(true);
    expect(upstreamCall).not.toHaveBeenCalled();
  });

  it('invalidates after a thrown upstream error and does not retry', async () => {
    const testHarness = harness();
    upstreamCall.mockRejectedValue(new Error('contract changed'));

    const result = await execute(testHarness.dependencies);

    expect(result.isError).toBe(true);
    expect(upstreamCall).toHaveBeenCalledOnce();
    expect(testHarness.invalidateProvider).toHaveBeenCalledExactlyOnceWith(
      '11111111-1111-4111-8111-111111111111',
      'github',
    );
  });

  it('invalidates an MCP error result and returns it without retrying', async () => {
    const testHarness = harness();
    const failure: CallToolResult = {
      content: [{ type: 'text', text: 'Tool contract rejected' }],
      isError: true,
    };
    upstreamCall.mockResolvedValue(failure);

    const result = await execute(testHarness.dependencies);

    expect(result).toBe(failure);
    expect(upstreamCall).toHaveBeenCalledOnce();
    expect(testHarness.invalidateProvider).toHaveBeenCalledOnce();
  });

  it('keeps the catalog when execution succeeds', async () => {
    const testHarness = harness();

    await expect(execute(testHarness.dependencies)).resolves.toBe(success);

    expect(testHarness.invalidateProvider).not.toHaveBeenCalled();
  });
});
