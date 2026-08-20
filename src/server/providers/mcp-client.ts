import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
} from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { normalizeUpstreamTool, type DiscoveredTool } from '../tools/catalog.js';
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
  listTools: Client['listTools'];
  callTool: Client['callTool'];
};

type VerifiedUpstreamToolCall = Pick<
  UpstreamToolCall,
  'provider' | 'tool' | 'arguments' | 'signal'
>;

export async function callUpstreamTool(request: UpstreamToolCall): Promise<CallToolResult> {
  return withUpstreamConnection(request, async ({ client }) => callVerifiedUpstreamTool(client, request));
}

export async function callVerifiedUpstreamTool(
  client: UpstreamToolExecutionClient,
  request: VerifiedUpstreamToolCall,
): Promise<CallToolResult> {
  const currentTools = await client.listTools(undefined, {
    ...(request.signal ? { signal: request.signal } : {}),
    timeout: UPSTREAM_LIST_TIMEOUT_MS,
    cacheMode: 'refresh',
  });
  const currentDefinition = currentTools.tools.find((tool) => tool.name === request.tool.upstreamName);
  if (!currentDefinition) throw new Error(`Upstream tool disappeared: ${request.tool.upstreamName}`);
  const currentTool = normalizeUpstreamTool(request.provider, currentDefinition);
  if (currentTool.fingerprint !== request.tool.fingerprint) {
    throw new Error(`Upstream tool changed after approval: ${request.tool.upstreamName}`);
  }
  return client.callTool(
    { name: currentDefinition.name, arguments: request.arguments },
    {
      ...(request.signal ? { signal: request.signal } : {}),
      timeout: UPSTREAM_CALL_TIMEOUT_MS,
      toolDefinition: currentDefinition,
    },
  );
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
