import type { Tool } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callUpstreamTool,
  callVerifiedUpstreamTool,
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

const verifiedCall: Parameters<typeof callVerifiedUpstreamTool>[1] = {
  provider,
  tool: normalizeUpstreamTool(provider, approvedDefinition),
  arguments: { issueNumber: 42 },
};

function executionClient(tools: Tool[]): {
  client: UpstreamToolExecutionClient;
  listTools: ReturnType<typeof vi.fn<UpstreamToolExecutionClient['listTools']>>;
  callTool: ReturnType<typeof vi.fn<UpstreamToolExecutionClient['callTool']>>;
} {
  const listTools = vi.fn<UpstreamToolExecutionClient['listTools']>();
  const callTool = vi.fn<UpstreamToolExecutionClient['callTool']>();
  listTools.mockResolvedValue({ tools });
  callTool.mockResolvedValue(toolResult);
  return { client: { listTools, callTool }, listTools, callTool };
}

beforeEach(() => {
  vi.clearAllMocks();
  sdkClient.connect.mockResolvedValue();
  sdkClient.close.mockResolvedValue();
  sdkClient.listTools.mockResolvedValue({ tools: [] });
  sdkClient.callTool.mockResolvedValue(toolResult);
});

describe('execution-time upstream tool verification', () => {
  it('denies a missing upstream definition without calling the tool', async () => {
    const { client, callTool } = executionClient([]);

    await expect(callVerifiedUpstreamTool(client, verifiedCall))
      .rejects.toThrow('Upstream tool disappeared: get_issue');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('denies a changed normalized fingerprint without calling the tool', async () => {
    const changedDefinition: Tool = { ...approvedDefinition, description: 'Changed after approval.' };
    const { client, callTool } = executionClient([changedDefinition]);

    await expect(callVerifiedUpstreamTool(client, verifiedCall))
      .rejects.toThrow('Upstream tool changed after approval: get_issue');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('calls the current matching definition with the current name and arguments', async () => {
    const currentDefinition: Tool = { ...approvedDefinition };
    const { client, listTools, callTool } = executionClient([currentDefinition]);
    const signal = new AbortController().signal;

    await expect(callVerifiedUpstreamTool(client, { ...verifiedCall, signal })).resolves.toBe(toolResult);
    expect(listTools).toHaveBeenCalledExactlyOnceWith(undefined, {
      signal,
      timeout: 15_000,
      cacheMode: 'refresh',
    });
    expect(callTool).toHaveBeenCalledExactlyOnceWith(
      { name: currentDefinition.name, arguments: verifiedCall.arguments },
      { signal, timeout: 60_000, toolDefinition: currentDefinition },
    );
  });
});

describe('upstream connection cleanup', () => {
  it('verifies and calls through the real connection wrapper', async () => {
    sdkClient.listTools.mockResolvedValue({ tools: [approvedDefinition] });

    await expect(callUpstreamTool({
      ...verifiedCall,
      accessToken: 'access-token',
    })).resolves.toBe(toolResult);

    expect(sdkClient.callTool).toHaveBeenCalledExactlyOnceWith(
      { name: approvedDefinition.name, arguments: verifiedCall.arguments },
      { timeout: 60_000, toolDefinition: approvedDefinition },
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
