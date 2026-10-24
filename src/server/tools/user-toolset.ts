import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import type { Coordinator } from '../coordination.js';
import type { Database } from '../database/index.js';
import { AgentFacingError } from '../errors.js';
import { errorSummary, logger } from '../logger.js';
import type { OAuthService } from '../oauth.js';
import { callCachedUpstreamTool } from '../providers/mcp-client.js';
import { PROVIDER_REGISTRY } from '../providers/registry.js';
import type { ProviderId, ProviderMount } from '../providers/types.js';
import type { UpstreamClientPool } from '../providers/upstream-pool.js';
import { effectivePolicyState, isToolEnabled, type DiscoveredTool } from './catalog.js';
import type { ToolDiscoveryService } from './discovery.js';
import { visibleTools } from './filter.js';

const RATE_LIMITS_PER_MINUTE: Readonly<Record<ProviderId, number>> = { github: 80, linear: 120, sentry: 50, slack: 50, notion: 50, granola: 100 };
const CONCURRENCY_LIMITS: Readonly<Record<ProviderId, number>> = { github: 10, linear: 10, sentry: 5, slack: 5, notion: 5, granola: 5 };

export type UserToolDependencies = {
  config: Config;
  database: Database;
  coordinator: Coordinator;
  oauth: OAuthService;
  toolDiscovery: ToolDiscoveryService;
  upstreamClients: Pick<UpstreamClientPool, 'withClient'>;
  mounts: readonly ProviderMount[];
};

export type ToolExecutionDependencies = Omit<UserToolDependencies, 'mounts'>;

export async function loadVisibleUserTools(request: {
  userId: string;
  signal?: AbortSignal;
  dependencies: UserToolDependencies;
}): Promise<readonly DiscoveredTool[]> {
  return resolveVisibleTools(request, undefined);
}

/**
 * The one tool a `tools/call` names, if this user may see it; otherwise
 * undefined, exactly as if the full listing had left it out.
 *
 * It runs the same resolution as `loadVisibleUserTools` — same reads, same
 * discovery service, same `isToolEnabled` and `visibleTools` — with two
 * narrowings that only shrink the work: discovery is asked for the one
 * provider whose prefix the name carries, and only definitions with that name
 * reach the filter. Neither narrowing decides visibility.
 */
export async function loadVisibleUserTool(request: {
  userId: string;
  toolName: string;
  signal?: AbortSignal;
  dependencies: UserToolDependencies;
}): Promise<DiscoveredTool | undefined> {
  const provider = PROVIDER_REGISTRY.find((entry) => request.toolName.startsWith(entry.prefix));
  if (!provider) return undefined;
  const [tool] = await resolveVisibleTools(request, { providerId: provider.id, toolName: request.toolName });
  return tool;
}

async function resolveVisibleTools(
  request: { userId: string; signal?: AbortSignal; dependencies: UserToolDependencies },
  only: { providerId: ProviderId; toolName: string } | undefined,
): Promise<readonly DiscoveredTool[]> {
  const { database, mounts, toolDiscovery } = request.dependencies;
  const [{ connectedProviders, hiddenProviders, toolPreferences }, toolPolicies] = await Promise.all([
    database.userVisibilityState(request.userId),
    database.toolPolicyDecisions(),
  ]);
  const discovery = await toolDiscovery.discoverConnected({
    userId: request.userId,
    // Discovery applies its own connected and hidden checks; this only keeps
    // it from reading other providers' cached listings.
    connectedProviders: only
      ? new Set([...connectedProviders].filter((providerId) => providerId === only.providerId))
      : connectedProviders,
    hiddenProviders,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  const candidates = only ? discovery.tools.filter((tool) => tool.name === only.toolName) : discovery.tools;
  const enabledTools = new Set(candidates
    .filter((tool) => isToolEnabled(tool, toolPolicies, toolPreferences))
    .map((tool) => tool.name));
  return visibleTools(candidates, mounts, { connectedProviders, hiddenProviders, enabledTools });
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
    // Policies come from the database on every call, never from the cache: an
    // administrator blocking a tool has to take effect now, not once a listing
    // somewhere expires.
    const currentPolicies = await request.dependencies.database.toolPolicyDecisions();
    if (effectivePolicyState(request.tool, currentPolicies) === 'blocked') {
      throw new Error(`Tool ${request.tool.name} is not permitted by this deployment`);
    }
    await request.dependencies.coordinator.enforceRateLimit({
      provider: provider.id,
      userId: request.userId,
      maximumStarts: RATE_LIMITS_PER_MINUTE[provider.id],
    });
    const accessToken = await request.dependencies.oauth.getOrRefreshAccessToken(request.userId, provider.id);
    const result = await request.dependencies.coordinator.withConcurrencyLease({
      provider: provider.id,
      userId: request.userId,
      maximumInFlight: CONCURRENCY_LIMITS[provider.id],
      operation: () => callProviderTool({
        userId: request.userId,
        tool: request.tool,
        input: request.input,
        accessToken,
        provider,
        toolDiscovery: request.dependencies.toolDiscovery,
        upstreamClients: request.dependencies.upstreamClients,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
    });
    logToolCall({
      startedAt,
      userId: request.userId,
      clientId: request.clientId,
      toolName: request.tool.name,
      requestId,
      status: result.isError === true ? 'error' : 'ok',
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

type ProviderToolCall = {
  userId: string;
  tool: DiscoveredTool;
  input: Record<string, unknown>;
  accessToken: string;
  provider: (typeof PROVIDER_REGISTRY)[number];
  toolDiscovery: ToolDiscoveryService;
  upstreamClients: Pick<UpstreamClientPool, 'withClient'>;
  signal?: AbortSignal;
};

/**
 * A failed call is the one strong signal that this user's cached listing may no
 * longer describe reality — the tool may have been renamed, withdrawn, or had
 * its permissions changed upstream. Dropping the listing makes the next request
 * rediscover it. A failure that reaches here is never retried: it may well be
 * a side effect that already happened. The pool's single resend covers only a
 * session the provider dropped before processing anything.
 */
async function callProviderTool(request: ProviderToolCall): Promise<CallToolResult> {
  try {
    const signalOption = request.signal ? { signal: request.signal } : {};
    const result = await request.upstreamClients.withClient(
      { userId: request.userId, provider: request.provider, accessToken: request.accessToken, ...signalOption },
      async (client) => callCachedUpstreamTool(client, { tool: request.tool, arguments: request.input, ...signalOption }),
    );
    if (result.isError === true) await invalidateAfterFailedCall(request);
    return result;
  } catch (error) {
    await invalidateAfterFailedCall(request);
    throw error;
  }
}

async function invalidateAfterFailedCall(request: ProviderToolCall): Promise<void> {
  try {
    await request.toolDiscovery.invalidateProvider(request.userId, request.tool.providerId);
  } catch (error) {
    // The tool failure is the news; losing the invalidation only costs a stale
    // listing until it expires, and must not replace the original error.
    logger.warn({ providerId: request.tool.providerId, ...errorSummary(error) }, 'Failed to invalidate cached MCP tools after a tool call failure');
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
