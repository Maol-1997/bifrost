import { errorSummary, logger } from '../logger.js';
import type { OAuthService } from '../oauth.js';
import { listClientTools } from '../providers/mcp-client.js';
import { PROVIDER_REGISTRY } from '../providers/registry.js';
import type { ProviderId, ProviderMount } from '../providers/types.js';
import type { UpstreamClientPool } from '../providers/upstream-pool.js';
import { mcpToolNameSchema, normalizeUpstreamTool, type DiscoveredTool } from './catalog.js';
import type { ToolCacheStore } from './cache-store.js';
import {
  aggregateToolCacheHints,
  ToolDiscoveryCache,
  toolCacheHintFromError,
  type CachedToolDiscovery,
  type ToolCacheHint,
  type ToolCacheKey,
  type ToolDiscoveryCacheOptions,
} from './discovery-cache.js';

export { mcpToolNameSchema } from './catalog.js';

export type ToolDiscoveryDependencies = {
  oauth: OAuthService;
  mounts: readonly ProviderMount[];
  store: ToolCacheStore;
  upstreamClients: Pick<UpstreamClientPool, 'withClient'>;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  /** Sees every listing loaded from upstream, cached or not; must not throw or block. */
  onFreshTools?: (providerId: ProviderId, tools: readonly DiscoveredTool[]) => void;
};

export type ProviderDiscoveryRequest = {
  userId: string;
  providerId: ProviderId;
  signal?: AbortSignal;
};

export type ConnectedDiscoveryRequest = {
  userId: string;
  connectedProviders: ReadonlySet<ProviderId>;
  hiddenProviders: ReadonlySet<ProviderId>;
  signal?: AbortSignal;
};

export type ToolDiscoveryResult = {
  tools: readonly DiscoveredTool[];
  failures: readonly { providerId: ProviderId; message: string }[];
  cache: ToolCacheHint;
};

/**
 * Discovery for one deployment, held by the dependency graph rather than by the
 * module. A per-request MCP server is only ever as correct as the listing
 * behind it, and that listing is shared across workers through the injected
 * store — so who owns the cache has to be a decision the caller makes, not a
 * module-level singleton nothing can replace or reset.
 */
export class ToolDiscoveryService {
  private readonly cache: ToolDiscoveryCache;

  constructor(
    private readonly dependencies: ToolDiscoveryDependencies,
    options?: ToolDiscoveryCacheOptions,
  ) {
    this.cache = new ToolDiscoveryCache(
      {
        store: dependencies.store,
        ...(dependencies.now ? { now: dependencies.now } : {}),
        ...(dependencies.delay ? { delay: dependencies.delay } : {}),
        onBackgroundError: (error) => {
          logger.warn(errorSummary(error), 'Official MCP background revalidation failed');
        },
        onUnreadableEntry: (error) => {
          logger.warn(errorSummary(error), 'Discarded an unreadable cached MCP tool listing');
        },
      },
      options,
    );
  }

  async discoverProvider(request: ProviderDiscoveryRequest): Promise<CachedToolDiscovery> {
    return this.cache.read(cacheKeyFor(request), {
      blocking: () => this.loadProviderTools(request),
      // The background loader deliberately drops the signal: the revalidation
      // outlives the request that noticed the entry had gone stale.
      background: () =>
        this.loadProviderTools({
          userId: request.userId,
          providerId: request.providerId,
        }),
    });
  }

  async discoverProviderFresh(request: ProviderDiscoveryRequest): Promise<CachedToolDiscovery> {
    return this.cache.readFresh(cacheKeyFor(request), () => this.loadProviderTools(request));
  }

  async invalidateProvider(userId: string, providerId: ProviderId): Promise<void> {
    await this.cache.invalidate({ userId, providerId });
  }

  async discoverConnected(request: ConnectedDiscoveryRequest): Promise<ToolDiscoveryResult> {
    const providerIds = PROVIDER_REGISTRY.map((provider) => provider.id).filter(
      (providerId) => request.connectedProviders.has(providerId) && !request.hiddenProviders.has(providerId),
    );
    const results = await Promise.allSettled(
      providerIds.map(async (providerId) => ({
        providerId,
        discovery: await this.discoverProvider({
          userId: request.userId,
          providerId,
          ...(request.signal ? { signal: request.signal } : {}),
        }),
      })),
    );

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

  private async loadProviderTools(request: ProviderDiscoveryRequest): Promise<readonly DiscoveredTool[]> {
    const provider = PROVIDER_REGISTRY.find((entry) => entry.id === request.providerId);
    if (!provider) throw new Error(`Unknown provider: ${request.providerId}`);
    if (!this.dependencies.mounts.some((mount) => mount.providerId === provider.id && mount.isMounted)) {
      throw new Error(`Provider is not mounted: ${provider.id}`);
    }
    const accessToken = await this.dependencies.oauth.getOrRefreshAccessToken(request.userId, provider.id);
    const upstreamTools = await this.dependencies.upstreamClients.withClient(
      { userId: request.userId, provider, accessToken, ...(request.signal ? { signal: request.signal } : {}) },
      async (client) => listClientTools(client, request.signal),
    );
    // One provider publishing a duplicate name must not take the whole MCP
    // endpoint down: registering the same name twice throws inside the
    // per-request server factory, which would fail every request for this user
    // across every provider. First definition wins, the rest are logged.
    const seenNames = new Set<string>();
    const tools = upstreamTools
      .map((tool) => normalizeUpstreamTool(provider, tool))
      .filter((tool) => {
        if (!mcpToolNameSchema.safeParse(tool.name).success) {
          logger.warn(
            { providerId: provider.id, upstreamToolName: tool.upstreamName },
            'Ignored upstream tool with an invalid Bifrost name',
          );
          return false;
        }
        if (seenNames.has(tool.name)) {
          logger.warn(
            { providerId: provider.id, toolName: tool.name },
            'Ignored upstream tool whose name is already published by this provider',
          );
          return false;
        }
        seenNames.add(tool.name);
        return true;
      });
    this.dependencies.onFreshTools?.(provider.id, tools);
    return tools;
  }
}

function cacheKeyFor(request: ProviderDiscoveryRequest): ToolCacheKey {
  return { userId: request.userId, providerId: request.providerId };
}
