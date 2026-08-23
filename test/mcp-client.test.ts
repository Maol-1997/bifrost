import type { Tool } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callCachedUpstreamTool,
  callUpstreamTool,
  listUpstreamTools,
  type UpstreamToolExecutionClient,
} from '../src/server/providers/mcp-client.js';
import type { ProviderDefinition } from '../src/server/providers/types.js';
import { normalizeUpstreamTool } from '../src/server/tools/catalog.js';

const sdkClient = vi.hoisted(() => ({
  connect: vi.fn<(transport: unknown, options: unknown) => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  listTools: vi.fn<(parameters: undefined, options: unknown) => Promise<{ tools: Tool[] }>>(),
  callTool: vi.fn<(
    request: { name: string; arguments: Record<string, unknown> },
    options: unknown,
  ) => Promise<CallToolResult>>(),
}));

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    connect(transport: unknown, options: unknown): Promise<void> {
      return sdkClient.connect(transport, options);
    }

    close(): Promise<void> {
      return sdkClient.close();
    }

    listTools(parameters: undefined, options: unknown): Promise<{ tools: Tool[] }> {
      return sdkClient.listTools(parameters, options);
    }

    callTool(
      request: { name: string; arguments: Record<string, unknown> },
      options: unknown,
    ): Promise<CallToolResult> {
      return sdkClient.callTool(request, options);
    }
  },
  StreamableHTTPClientTransport: class {
    readonly kind = 'test-transport';
  },
}));

const provider: ProviderDefinition = {
  id: 'github',
  prefix: 'github_',
  displayName: 'GitHub',
  mcpUrl: 'https://example.test/mcp',
  oauth: { kind: 'static', authorizationUrl: '', tokenUrl: '', scopes: [] },
};

const approvedDefinition: Tool = {
  name: 'get_issue',
  description: 'Get an issue.',
  inputSchema: { type: 'object', properties: { issueNumber: { type: 'number' } } },
};

const toolResult: CallToolResult = {
  content: [{ type: 'text', text: 'Issue 42' }],
};

const approvedCall: Parameters<typeof callCachedUpstreamTool>[1] = {
  tool: normalizeUpstreamTool(provider, approvedDefinition),
  arguments: { issueNumber: 42 },
};

function executionClient(): {
  client: UpstreamToolExecutionClient;
  callTool: ReturnType<typeof vi.fn<UpstreamToolExecutionClient['callTool']>>;
} {
  const callTool = vi.fn<UpstreamToolExecutionClient['callTool']>();
  callTool.mockResolvedValue(toolResult);
  return { client: { callTool }, callTool };
}

beforeEach(() => {
  vi.clearAllMocks();
  sdkClient.connect.mockResolvedValue();
  sdkClient.close.mockResolvedValue();
  sdkClient.listTools.mockResolvedValue({ tools: [] });
  sdkClient.callTool.mockResolvedValue(toolResult);
});

describe('calling an approved upstream tool', () => {
  it('sends the approved contract as the definition instead of listing again', async () => {
    const { client, callTool } = executionClient();
    const signal = new AbortController().signal;

    await expect(callCachedUpstreamTool(client, { ...approvedCall, signal })).resolves.toBe(toolResult);

    expect(callTool).toHaveBeenCalledExactlyOnceWith(
      { name: 'get_issue', arguments: approvedCall.arguments },
      { signal, timeout: 60_000, toolDefinition: approvedCall.tool.contract.tool },
    );
  });

  it('calls the upstream name, not the prefixed Bifrost name', async () => {
    const { client, callTool } = executionClient();

    await callCachedUpstreamTool(client, approvedCall);

    expect(approvedCall.tool.name).toBe('github_get_issue');
    expect(callTool.mock.calls[0]?.[0]).toMatchObject({ name: 'get_issue' });
  });

  it('does not spend an upstream listing on every tool call', async () => {
    await callUpstreamTool({ ...approvedCall, provider, accessToken: 'access-token' });

    expect(sdkClient.listTools).not.toHaveBeenCalled();
    expect(sdkClient.callTool).toHaveBeenCalledOnce();
  });
});

describe('upstream connection cleanup', () => {
  it('calls through the real connection wrapper and closes it', async () => {
    await expect(callUpstreamTool({
      ...approvedCall,
      provider,
      accessToken: 'access-token',
    })).resolves.toBe(toolResult);

    expect(sdkClient.callTool).toHaveBeenCalledExactlyOnceWith(
      { name: approvedDefinition.name, arguments: approvedCall.arguments },
      { timeout: 60_000, toolDefinition: approvedCall.tool.contract.tool },
    );
    expect(sdkClient.close).toHaveBeenCalledOnce();
  });

  it('closes the client after a successful operation', async () => {
    await expect(listUpstreamTools(provider, 'access-token')).resolves.toEqual([]);

    expect(sdkClient.close).toHaveBeenCalledOnce();
  });

  it('closes the client after an operation failure', async () => {
    const failure = new Error('list failed');
    sdkClient.listTools.mockRejectedValue(failure);

    await expect(listUpstreamTools(provider, 'access-token')).rejects.toBe(failure);
    expect(sdkClient.close).toHaveBeenCalledOnce();
  });

  it('closes the client after a connection failure', async () => {
    const failure = new Error('connect failed');
    sdkClient.connect.mockRejectedValue(failure);

    await expect(listUpstreamTools(provider, 'access-token')).rejects.toBe(failure);
    expect(sdkClient.close).toHaveBeenCalledOnce();
    expect(sdkClient.listTools).not.toHaveBeenCalled();
  });
});
