import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
} from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { DiscoveredTool } from '../tools/catalog.js';
import type { ProviderDefinition } from './types.js';
import type { PooledUpstreamClient } from './upstream-pool.js';

const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const UPSTREAM_LIST_TIMEOUT_MS = 15_000;
const UPSTREAM_CALL_TIMEOUT_MS = 60_000;

/**
 * Opens a client for one user's credential. It is shared by every later request
 * for that user and provider, so it deliberately takes no request's abort
 * signal: one caller giving up must not tear down the others' connection.
 */
export async function connectUpstreamClient(provider: ProviderDefinition, accessToken: string): Promise<PooledUpstreamClient> {
  const client = new Client({ name: 'bifrost-upstream', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(provider.mcpUrl), {
    authProvider: { token: async () => accessToken },
    onInsufficientScope: 'throw',
  });
  try {
    await client.connect(transport, { timeout: UPSTREAM_CONNECT_TIMEOUT_MS });
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export async function listClientTools(client: Pick<Client, 'listTools'>, signal?: AbortSignal): Promise<readonly Tool[]> {
  const result = await client.listTools(undefined, {
    ...(signal ? { signal } : {}), timeout: UPSTREAM_LIST_TIMEOUT_MS, cacheMode: 'refresh',
  });
  return result.tools;
}

export type UpstreamToolExecutionClient = {
  callTool: Client['callTool'];
};

type CachedUpstreamToolCall = {
  tool: DiscoveredTool;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
};

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
