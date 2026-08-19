import { errorSummary, logger } from '../logger.js';
import { listUpstreamTools } from '../providers/mcp-client.js';
import { PROVIDER_REGISTRY } from '../providers/registry.js';
import type { ProviderId, ProviderMount } from '../providers/types.js';
import type { OAuthService } from '../oauth.js';
import { normalizeUpstreamTool, type DiscoveredTool } from './catalog.js';
import {
  aggregateToolCacheHints,
  TOOL_DISCOVERY_CACHE_OPTIONS,
  ToolDiscoveryCache,
  toolCacheHintFromError,
  type CachedToolDiscovery,
  type ToolCacheHint,
} from './discovery-cache.js';

const MCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const providerToolDiscoveryCache = new ToolDiscoveryCache({
  ...TOOL_DISCOVERY_CACHE_OPTIONS,
  onBackgroundError: (error) => {
    logger.warn(errorSummary(error), 'Official MCP background revalidation failed');
  },
});

type ProviderDiscoveryRequest = {
  userId: string;
  providerId: ProviderId;
  oauth: OAuthService;
  mounts: readonly ProviderMount[];
  signal?: AbortSignal;
};

export async function discoverProviderTools(request: ProviderDiscoveryRequest): Promise<CachedToolDiscovery> {
  const key = providerCacheKey(request.userId, request.providerId);
  return providerToolDiscoveryCache.read(key, {
    blocking: () => loadProviderTools(request),
    background: () => loadProviderTools({
      userId: request.userId,
      providerId: request.providerId,
      oauth: request.oauth,
      mounts: request.mounts,
    }),
  });
}

export async function discoverProviderToolsFresh(request: ProviderDiscoveryRequest): Promise<CachedToolDiscovery> {
  return providerToolDiscoveryCache.readFresh(
    providerCacheKey(request.userId, request.providerId),
    () => loadProviderTools(request),
  );
}

export function invalidateProviderToolDiscovery(userId: string, providerId: ProviderId): void {
  providerToolDiscoveryCache.invalidate(providerCacheKey(userId, providerId));
}

async function loadProviderTools(request: ProviderDiscoveryRequest): Promise<readonly DiscoveredTool[]> {
  const provider = PROVIDER_REGISTRY.find((entry) => entry.id === request.providerId);
  if (!provider) throw new Error(`Unknown provider: ${request.providerId}`);
  if (!request.mounts.some((mount) => mount.providerId === provider.id && mount.isMounted)) {
    throw new Error(`Provider is not mounted: ${provider.id}`);
  }
  const accessToken = await request.oauth.getOrRefreshAccessToken(request.userId, provider.id);
  const upstreamTools = await listUpstreamTools(provider, accessToken, request.signal);
  return upstreamTools
    .map((tool) => normalizeUpstreamTool(provider, tool))
    .filter((tool) => {
      if (!MCP_TOOL_NAME.test(tool.name)) {
        logger.warn({ providerId: provider.id, upstreamToolName: tool.upstreamName }, 'Ignored upstream tool with an invalid Bifrost name');
        return false;
      }
      return true;
    });
}

type ConnectedDiscoveryRequest = Omit<ProviderDiscoveryRequest, 'providerId'> & {
  connectedProviders: ReadonlySet<ProviderId>;
  hiddenProviders: ReadonlySet<ProviderId>;
};

export type ToolDiscoveryResult = {
  tools: readonly DiscoveredTool[];
  failures: readonly { providerId: ProviderId; message: string }[];
  cache: ToolCacheHint;
};

export async function discoverConnectedTools(request: ConnectedDiscoveryRequest): Promise<ToolDiscoveryResult> {
  const providerIds = PROVIDER_REGISTRY
    .map((provider) => provider.id)
    .filter((providerId) => request.connectedProviders.has(providerId) && !request.hiddenProviders.has(providerId));
  const results = await Promise.allSettled(providerIds.map(async (providerId) => ({
    providerId,
    discovery: await discoverProviderTools({
      userId: request.userId,
      providerId,
      oauth: request.oauth,
      mounts: request.mounts,
      ...(request.signal ? { signal: request.signal } : {}),
    }),
  })));
  const tools: DiscoveredTool[] = [];
  const failures: { providerId: ProviderId; message: string }[] = [];
  const cacheHints: ToolCacheHint[] = [];
  for (const [index, result] of results.entries()) {
    const providerId = providerIds[index];
    if (!providerId) continue;
    if (result.status === 'fulfilled') {
      tools.push(...result.value.discovery.tools);
      cacheHints.push(result.value.discovery.cache);
      continue;
    }
    logger.warn({ providerId, ...errorSummary(result.reason) }, 'Official MCP tool discovery failed');
    failures.push({ providerId, message: 'Tool discovery failed' });
    cacheHints.push(toolCacheHintFromError(result.reason));
  }
  return { tools, failures, cache: aggregateToolCacheHints(cacheHints) };
}

function providerCacheKey(userId: string, providerId: ProviderId): string {
  return `${userId}:${providerId}`;
}
