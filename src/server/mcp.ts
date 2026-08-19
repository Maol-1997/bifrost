import { randomUUID } from 'node:crypto';
import { createMcpHandler, fromJsonSchema, LATEST_PROTOCOL_VERSION, McpServer, type AuthInfo, type JsonSchemaType, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { Coordinator } from './coordination.js';
import { Database } from './db.js';
import { AgentFacingError } from './errors.js';
import { errorSummary, logger } from './logger.js';
import { OAuthService } from './oauth.js';
import { callUpstreamTool } from './providers/mcp-client.js';
import { PROVIDER_REGISTRY } from './providers/registry.js';
import type { ProviderId, ProviderMount } from './providers/types.js';
import { effectivePolicyState, isToolEnabled, type DiscoveredTool } from './tools/catalog.js';
import { discoverConnectedTools } from './tools/discovery.js';
import { visibleTools } from './tools/filter.js';

const RATE_LIMITS_PER_MINUTE: Readonly<Record<ProviderId, number>> = { github: 80, linear: 120, sentry: 50, slack: 50, notion: 50 };
const CONCURRENCY_LIMITS: Readonly<Record<ProviderId, number>> = { github: 10, linear: 10, sentry: 5, slack: 5, notion: 5 };

/**
 * Who is calling, however they proved it.
 *
 * `browser` is a cookie-backed session; `agent` is an OAuth grant reached with a
 * bearer access token. The two live in different tables and must never be
 * confused for one another, so each carries its own handle instead of a shared
 * `id` whose meaning depends on `kind`.
 */
export type HumanIdentity =
  | ({ kind: 'browser'; sessionId: string } & HumanIdentityCommon)
  | ({ kind: 'agent'; grantId: string } & HumanIdentityCommon);

type HumanIdentityCommon = {
  userId: string;
  clientId: string;
  expiresAt: Date;
  token: string;
  scopes: readonly string[];
};

export function toAuthInfo(identity: HumanIdentity): AuthInfo {
  return {
    token: identity.token,
    clientId: identity.clientId,
    scopes: [...identity.scopes],
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
    const [connectedProviders, hiddenProviders, toolPreferences, toolPolicies] = await Promise.all([
      dependencies.database.connectedProviders(userId),
      dependencies.database.hiddenProviders(userId),
      dependencies.database.toolPreferences(userId),
      dependencies.database.toolPolicies(),
    ]);
    const discovery = await discoverConnectedTools({
      userId,
      connectedProviders,
      hiddenProviders,
      oauth: dependencies.oauth,
      mounts: dependencies.mounts,
      ...(requestContext.requestInfo ? { signal: requestContext.requestInfo.signal } : {}),
    });
    const enabledTools = new Set(discovery.tools
      .filter((tool) => isToolEnabled(tool, toolPolicies, toolPreferences))
      .map((tool) => tool.name));
    const tools = visibleTools(discovery.tools, dependencies.mounts, {
      connectedProviders,
      hiddenProviders,
      enabledTools,
    });
    const server = new McpServer(
      { name: 'bifrost', version: '0.1.0' },
      { capabilities: { tools: {} }, instructions: `Bifrost unified internal gateway. Protocol ${LATEST_PROTOCOL_VERSION}.` },
    );
    for (const tool of tools) registerTool(server, tool, { userId, authInfo: requestContext.authInfo, dependencies });
    return server;
  }, {
    legacy: 'reject',
    responseMode: 'json',
    onerror: (error) => logger.error(errorSummary(error), 'MCP handler error'),
  });
}

type ToolRegistration = {
  userId: string;
  authInfo: AuthInfo | undefined;
  dependencies: { config: Config; database: Database; coordinator: Coordinator; oauth: OAuthService };
};

function registerTool(server: McpServer, tool: DiscoveredTool, { userId, authInfo, dependencies }: ToolRegistration): void {
  const provider = PROVIDER_REGISTRY.find((entry) => entry.id === tool.providerId);
  if (!provider) throw new Error(`Tool has no registered provider: ${tool.name}`);
  server.registerTool(tool.name, {
    title: tool.title,
    description: tool.description,
    inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
    ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema as JsonSchemaType) } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }, async (input, context) => {
    const startedAt = performance.now();
    const requestId = context.mcpReq._meta?.requestId;
    const normalizedRequestId = typeof requestId === 'string' ? requestId : randomUUID();
    try {
      const currentPolicies = await dependencies.database.toolPolicies();
      if (effectivePolicyState(tool, currentPolicies) === 'blocked') {
        throw new Error(`Tool ${tool.name} is not permitted by this deployment`);
      }
      await dependencies.coordinator.enforceRateLimit(provider.id, RATE_LIMITS_PER_MINUTE[provider.id]);
      const accessToken = await dependencies.oauth.getOrRefreshAccessToken(userId, provider.id);
      const result = await dependencies.coordinator.withConcurrencyLease(
        provider.id,
        CONCURRENCY_LIMITS[provider.id],
        () => callUpstreamTool({
          provider,
          accessToken,
          tool,
          arguments: input as Record<string, unknown>,
          signal: context.mcpReq.signal,
        }),
      );
      logToolCall({ startedAt, userId, clientId: authInfo?.clientId ?? 'unknown', toolName: tool.name, requestId: normalizedRequestId, status: 'ok' }, dependencies.config.SLOW_TOOL_MS);
      return result;
    } catch (error) {
      logToolCall({ startedAt, userId, clientId: authInfo?.clientId ?? 'unknown', toolName: tool.name, requestId: normalizedRequestId, status: 'error' }, dependencies.config.SLOW_TOOL_MS, error);
      // Only errors written for the agent travel back verbatim. Everything else
      // was logged above and would only narrate internals to the caller.
      return { content: [{ type: 'text' as const, text: error instanceof AgentFacingError ? error.message : 'Tool call failed' }], isError: true };
    }
  });
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
