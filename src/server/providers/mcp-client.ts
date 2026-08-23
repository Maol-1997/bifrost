import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
} from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { DiscoveredTool } from '../tools/catalog.js';
import type { ProviderDefinition } from './types.js';

const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const UPSTREAM_LIST_TIMEOUT_MS = 15_000;
const UPSTREAM_CALL_TIMEOUT_MS = 60_000;

type UpstreamConnectionRequest = {
  provider: ProviderDefinition;
  accessToken: string;
  signal?: AbortSignal;
};

export async function listUpstreamTools(
  provider: ProviderDefinition,
  accessToken: string,
  signal?: AbortSignal,
): Promise<readonly Tool[]> {
  return withUpstreamConnection({ provider, accessToken, ...(signal ? { signal } : {}) }, async ({ client }) => {
    const result = await client.listTools(undefined, {
      ...(signal ? { signal } : {}), timeout: UPSTREAM_LIST_TIMEOUT_MS, cacheMode: 'refresh',
    });
    return result.tools;
  });
}

type UpstreamToolCall = UpstreamConnectionRequest & {
  tool: DiscoveredTool;
  arguments: Record<string, unknown>;
};

export type UpstreamToolExecutionClient = {
  callTool: Client['callTool'];
};

type CachedUpstreamToolCall = Pick<UpstreamToolCall, 'tool' | 'arguments' | 'signal'>;

export async function callUpstreamTool(request: UpstreamToolCall): Promise<CallToolResult> {
  return withUpstreamConnection(request, async ({ client }) => callCachedUpstreamTool(client, request));
}

/**
 * Calls the exact definition the deployment approved. That definition is the
 * cached contract this tool's fingerprint was computed from, and execution has
 * already re-checked that fingerprint against the stored policy — so listing
 * upstream again would add a round trip to every tool call without proving
 * anything the cache does not already bound. Drift is caught by the freshness
 * window and by invalidating this user's listing whenever a call fails.
 */
export async function callCachedUpstreamTool(
  client: UpstreamToolExecutionClient,
  request: CachedUpstreamToolCall,
): Promise<CallToolResult> {
  return client.callTool(
    { name: request.tool.upstreamName, arguments: request.arguments },
    {
      ...(request.signal ? { signal: request.signal } : {}),
      timeout: UPSTREAM_CALL_TIMEOUT_MS,
      toolDefinition: approvedToolDefinition(request.tool),
    },
  );
}

function approvedToolDefinition(tool: DiscoveredTool): Tool {
  return tool.contract.tool as unknown as Tool;
}

async function withUpstreamConnection<Result>(
  request: UpstreamConnectionRequest,
  operation: (connection: { client: Client }) => Promise<Result>,
): Promise<Result> {
  const client = new Client({ name: 'bifrost-upstream', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(request.provider.mcpUrl), {
    authProvider: { token: async () => request.accessToken },
    onInsufficientScope: 'throw',
  });
  try {
    await client.connect(transport, {
      ...(request.signal ? { signal: request.signal } : {}), timeout: UPSTREAM_CONNECT_TIMEOUT_MS,
    });
    return await operation({ client });
  } finally {
    await client.close().catch(() => undefined);
  }
}
