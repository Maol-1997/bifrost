import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import type { Coordinator } from '../coordination.js';
import type { Database } from '../db.js';
import { AgentFacingError } from '../errors.js';
import { errorSummary, logger } from '../logger.js';
import type { OAuthService } from '../oauth.js';
import { callUpstreamTool } from '../providers/mcp-client.js';
import { PROVIDER_REGISTRY } from '../providers/registry.js';
import type { ProviderId, ProviderMount } from '../providers/types.js';
import { effectivePolicyState, isToolEnabled, type DiscoveredTool } from './catalog.js';
import { discoverConnectedTools } from './discovery.js';
import { visibleTools } from './filter.js';

const RATE_LIMITS_PER_MINUTE: Readonly<Record<ProviderId, number>> = { github: 80, linear: 120, sentry: 50, slack: 50, notion: 50 };
const CONCURRENCY_LIMITS: Readonly<Record<ProviderId, number>> = { github: 10, linear: 10, sentry: 5, slack: 5, notion: 5 };

export type UserToolDependencies = {
  config: Config;
  database: Database;
  coordinator: Coordinator;
  oauth: OAuthService;
  mounts: readonly ProviderMount[];
};

type ToolExecutionDependencies = Omit<UserToolDependencies, 'mounts'>;

export async function loadVisibleUserTools(request: {
  userId: string;
  signal?: AbortSignal;
  dependencies: UserToolDependencies;
}): Promise<readonly DiscoveredTool[]> {
  const { database, mounts, oauth } = request.dependencies;
  const [connectedProviders, hiddenProviders, toolPreferences, toolPolicies] = await Promise.all([
    database.connectedProviders(request.userId),
    database.hiddenProviders(request.userId),
    database.toolPreferences(request.userId),
    database.toolPolicies(),
  ]);
  const discovery = await discoverConnectedTools({
    userId: request.userId,
    connectedProviders,
    hiddenProviders,
    oauth,
    mounts,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  const enabledTools = new Set(discovery.tools
    .filter((tool) => isToolEnabled(tool, toolPolicies, toolPreferences))
    .map((tool) => tool.name));
  return visibleTools(discovery.tools, mounts, { connectedProviders, hiddenProviders, enabledTools });
}

export async function executeUserTool(request: {
  userId: string;
  clientId: string;
  tool: DiscoveredTool;
  input: Record<string, unknown>;
  signal?: AbortSignal;
  requestId?: string;
  dependencies: ToolExecutionDependencies;
}): Promise<CallToolResult> {
  const provider = PROVIDER_REGISTRY.find((entry) => entry.id === request.tool.providerId);
  if (!provider) throw new Error(`Tool has no registered provider: ${request.tool.name}`);
  const startedAt = performance.now();
  const requestId = request.requestId ?? randomUUID();

  try {
    const currentPolicies = await request.dependencies.database.toolPolicies();
    if (effectivePolicyState(request.tool, currentPolicies) === 'blocked') {
      throw new Error(`Tool ${request.tool.name} is not permitted by this deployment`);
    }
    await request.dependencies.coordinator.enforceRateLimit(provider.id, RATE_LIMITS_PER_MINUTE[provider.id]);
    const accessToken = await request.dependencies.oauth.getOrRefreshAccessToken(request.userId, provider.id);
    const result = await request.dependencies.coordinator.withConcurrencyLease(
      provider.id,
      CONCURRENCY_LIMITS[provider.id],
      () => callUpstreamTool({
        provider,
        accessToken,
        tool: request.tool,
        arguments: request.input,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
    );
    logToolCall({
      startedAt,
      userId: request.userId,
      clientId: request.clientId,
      toolName: request.tool.name,
      requestId,
      status: 'ok',
    }, request.dependencies.config.SLOW_TOOL_MS);
    return result;
  } catch (error) {
    logToolCall({
      startedAt,
      userId: request.userId,
      clientId: request.clientId,
      toolName: request.tool.name,
      requestId,
      status: 'error',
    }, request.dependencies.config.SLOW_TOOL_MS, error);
    return {
      content: [{ type: 'text', text: error instanceof AgentFacingError ? error.message : 'Tool call failed' }],
      isError: true,
    };
  }
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
