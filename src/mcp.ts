import { randomUUID } from 'node:crypto';
import { createMcpHandler, LATEST_PROTOCOL_VERSION, McpServer, type AuthInfo, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { Coordinator } from './coordination.js';
import { Database } from './db.js';
import { AgentFacingError } from './errors.js';
import { errorSummary, logger } from './logger.js';
import { OAuthService } from './oauth.js';
import { PROVIDER_REGISTRY } from './providers/registry.js';
import type { ProviderId, ProviderMount, ToolDefinition } from './providers/types.js';
import { visibleTools } from './tools/filter.js';
import { disabledToolNames, isWithinDeploymentCeiling } from './tools/preferences.js';

const RATE_LIMITS_PER_MINUTE: Readonly<Record<ProviderId, number>> = { github: 80, linear: 120, slack: 50 };
const CONCURRENCY_LIMITS: Readonly<Record<ProviderId, number>> = { github: 10, linear: 10, slack: 5 };

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
    const connectedProviders = await dependencies.database.connectedProviders(userId);
    const hiddenProviders = await dependencies.database.hiddenProviders(userId);
    const toolPreferences = await dependencies.database.toolPreferences(userId);
    const tools = visibleTools(PROVIDER_REGISTRY, dependencies.mounts, {
      endpoint: 'human',
      connectedProviders,
      hiddenProviders,
      disabledTools: disabledToolNames(PROVIDER_REGISTRY, toolPreferences, dependencies.config.writeToolAllowlist),
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
      // Redundant with the registration filter, and kept for exactly that
      // reason: a tool outside the deployment ceiling should never reach here,
      // so if it ever does, refusing beats trusting that the filter held.
      if (!isWithinDeploymentCeiling(tool, dependencies.config.writeToolAllowlist)) {
        throw new Error(`Write tool ${tool.name} is not permitted by this deployment`);
      }
      await dependencies.coordinator.enforceRateLimit(providerId, RATE_LIMITS_PER_MINUTE[providerId]);
      const accessToken = await dependencies.oauth.getOrRefreshAccessToken(userId, providerId);
      const result = await dependencies.coordinator.withConcurrencyLease(
        providerId,
        CONCURRENCY_LIMITS[providerId],
        () => tool.execute(input, { userId, accessToken, requestId: normalizedRequestId, signal: context.mcpReq.signal }),
      );
      logToolCall({ startedAt, userId, clientId: authInfo?.clientId ?? 'unknown', toolName: tool.name, requestId: normalizedRequestId, status: 'ok' }, dependencies.config.SLOW_TOOL_MS);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { result } };
    } catch (error) {
      logToolCall({ startedAt, userId, clientId: authInfo?.clientId ?? 'unknown', toolName: tool.name, requestId: normalizedRequestId, status: 'error' }, dependencies.config.SLOW_TOOL_MS, error);
      // Only errors written for the agent travel back verbatim. Everything else
      // was logged above and would only narrate internals to the caller.
      return { content: [{ type: 'text' as const, text: error instanceof AgentFacingError ? error.message : 'Tool call failed' }], isError: true };
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
