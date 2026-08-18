import { randomUUID } from 'node:crypto';
import { createMcpHandler, LATEST_PROTOCOL_VERSION, McpServer, type AuthInfo, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { Coordinator } from './coordination.js';
import { Database } from './db.js';
import { errorSummary, logger } from './logger.js';
import { OAuthService } from './oauth.js';
import { PROVIDER_REGISTRY } from './providers/registry.js';
import type { ProviderId, ProviderMount, ToolDefinition } from './providers/types.js';
import { visibleTools } from './tools/filter.js';

const RATE_LIMITS_PER_MINUTE: Readonly<Record<ProviderId, number>> = { github: 80, linear: 120, slack: 50 };
const CONCURRENCY_LIMITS: Readonly<Record<ProviderId, number>> = { github: 10, linear: 10, slack: 5 };

export type HumanIdentity = { userId: string; clientId: string; expiresAt: Date; token: string };

export function toAuthInfo(identity: HumanIdentity): AuthInfo {
  return {
    token: identity.token,
    clientId: identity.clientId,
    scopes: ['mcp'],
    expiresAt: Math.floor(identity.expiresAt.getTime() / 1000),
    extra: { userId: identity.userId },
  };
}

export function createHumanMcpHandler(dependencies: {
  config: Config;
  database: Database;
  coordinator: Coordinator;
  oauth: OAuthService;
  mounts: readonly ProviderMount[];
}): McpHttpHandler {
  return createMcpHandler(async (requestContext) => {
    const userId = requestContext.authInfo?.extra?.userId;
    if (typeof userId !== 'string') throw new Error('Authenticated user identity is missing');
    const connectedProviders = await dependencies.database.connectedProviders(userId);
    const hiddenProviders = await dependencies.database.hiddenProviders(userId);
    const tools = visibleTools(PROVIDER_REGISTRY, dependencies.mounts, {
      endpoint: 'human', connectedProviders, hiddenProviders,
    });
    const server = new McpServer(
      { name: 'bifrost', version: '0.1.0' },
      { capabilities: { tools: {} }, instructions: `Bifrost unified internal gateway. Protocol ${LATEST_PROTOCOL_VERSION}.` },
    );
    for (const tool of tools) registerTool(server, tool, userId, requestContext.authInfo, dependencies);
    return server;
  }, {
    legacy: 'reject',
    responseMode: 'json',
    onerror: (error) => logger.error(errorSummary(error), 'MCP handler error'),
  });
}

function registerTool(
  server: McpServer,
  tool: ToolDefinition,
  userId: string,
  authInfo: AuthInfo | undefined,
  dependencies: {
    config: Config;
    coordinator: Coordinator;
    oauth: OAuthService;
  },
): void {
  const providerId = providerForTool(tool.name);
  server.registerTool(tool.name, {
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.mutability === 'read', destructiveHint: tool.mutability === 'write' },
  }, async (input, context) => {
    const startedAt = performance.now();
    const requestId = context.mcpReq._meta?.requestId;
    const normalizedRequestId = typeof requestId === 'string' ? requestId : randomUUID();
    try {
      if (tool.mutability === 'write' && !dependencies.config.writeToolAllowlist.has(tool.name)) {
        throw new Error(`Write tool ${tool.name} is disabled by the server-side allowlist`);
      }
      await dependencies.coordinator.enforceRateLimit(providerId, RATE_LIMITS_PER_MINUTE[providerId]);
      const accessToken = await dependencies.oauth.accessToken(userId, providerId);
      const result = await dependencies.coordinator.withConcurrencyLease(
        providerId,
        CONCURRENCY_LIMITS[providerId],
        () => tool.execute(input, { userId, accessToken, requestId: normalizedRequestId, signal: context.mcpReq.signal }),
      );
      logToolCall({ startedAt, userId, clientId: authInfo?.clientId ?? 'unknown', toolName: tool.name, requestId: normalizedRequestId, status: 'ok' }, dependencies.config.SLOW_TOOL_MS);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { result } };
    } catch (error) {
      logToolCall({ startedAt, userId, clientId: authInfo?.clientId ?? 'unknown', toolName: tool.name, requestId: normalizedRequestId, status: 'error' }, dependencies.config.SLOW_TOOL_MS, error);
      return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Tool call failed' }], isError: true };
    }
  });
}

function providerForTool(toolName: string): ProviderId {
  const provider = PROVIDER_REGISTRY.find((entry) => toolName.startsWith(entry.prefix));
  if (!provider) throw new Error(`Tool has no registered provider: ${toolName}`);
  return provider.id;
}

function logToolCall(
  details: { startedAt: number; userId: string; clientId: string; toolName: string; requestId: string; status: 'ok' | 'error' },
  slowThresholdMs: number,
  error?: unknown,
): void {
  const latencyMs = Math.round(performance.now() - details.startedAt);
  const fields = { ...details, latencyMs, ...(error === undefined ? {} : errorSummary(error)) };
  if (latencyMs >= slowThresholdMs) logger.warn(fields, 'Slow MCP tool call');
  else if (details.status === 'error') logger.error(fields, 'MCP tool call failed');
  else logger.info(fields, 'MCP tool call');
}
