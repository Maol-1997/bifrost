import type { DiscoveredTool } from './catalog.js';

export const TOOL_DISCOVERY_FRESHNESS_MS = 60 * 60 * 1_000;
export const TOOL_DISCOVERY_REVALIDATION_POLL_MS = 3_000;
export const TOOL_DISCOVERY_INITIAL_RETRY_MS = 5_000;
const TOOL_DISCOVERY_MAX_RETRY_MS = 5 * 60 * 1_000;
const TOOL_DISCOVERY_MAX_ENTRIES = 1_000;

export type ToolCacheState = 'fresh' | 'revalidating' | 'refresh_failed';

export type ToolCacheHint = {
  state: ToolCacheState;
  freshForMs: number;
  nextCheckInMs: number;
};

export type CachedToolDiscovery = {
  tools: readonly DiscoveredTool[];
  cache: ToolCacheHint;
};

type CacheEntry = {
  tools: readonly DiscoveredTool[];
  freshUntil: number;
  failureCount: number;
  nextRetryAt: number;
};

type CacheFailure = {
  failureCount: number;
  nextRetryAt: number;
};

type ActiveRefreshes = Map<number, Promise<readonly DiscoveredTool[]>>;

type CacheLoaders = {
  blocking: () => Promise<readonly DiscoveredTool[]>;
  background: () => Promise<readonly DiscoveredTool[]>;
};

type CacheOptions = {
  freshnessMs: number;
  revalidationPollMs: number;
  initialRetryMs: number;
  maxRetryMs: number;
  maxEntries: number;
  now?: () => number;
  onBackgroundError?: (error: unknown) => void;
};

export class ToolDiscoveryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly failures = new Map<string, CacheFailure>();
  private readonly generations = new Map<string, number>();
  private readonly refreshes = new Map<string, ActiveRefreshes>();
  private readonly now: () => number;

  constructor(private readonly options: CacheOptions) {
    this.now = options.now ?? Date.now;
  }

  async read(key: string, loaders: CacheLoaders): Promise<CachedToolDiscovery> {
    const entry = this.entries.get(key);
    if (!entry) {
      const failure = this.failures.get(key);
      if (failure && this.now() < failure.nextRetryAt) {
        throw new ToolDiscoveryBackoffError(this.refreshFailedHint(failure.nextRetryAt - this.now()));
      }
      const tools = await this.refresh(key, loaders.blocking);
      return { tools, cache: this.freshHint() };
    }
    this.touch(key, entry);

    const now = this.now();
    if (now < entry.freshUntil) {
      return { tools: entry.tools, cache: this.freshHint(entry.freshUntil - now) };
    }

    const activeRefresh = this.activeRefresh(key);
    if (activeRefresh) return { tools: entry.tools, cache: this.revalidatingHint() };
    if (now < entry.nextRetryAt) {
      return { tools: entry.tools, cache: this.refreshFailedHint(entry.nextRetryAt - now) };
    }

    void this.refresh(key, loaders.background).catch((error: unknown) => {
      this.options.onBackgroundError?.(error);
    });
    return { tools: entry.tools, cache: this.revalidatingHint() };
  }

  async readFresh(key: string, load: () => Promise<readonly DiscoveredTool[]>): Promise<CachedToolDiscovery> {
    const tools = await this.refresh(key, load);
    return { tools, cache: this.freshHint() };
  }

  invalidate(key: string): void {
    this.entries.delete(key);
    this.failures.delete(key);
    this.supersedeActiveRefreshes(key);
  }

  private async refresh(key: string, load: () => Promise<readonly DiscoveredTool[]>): Promise<readonly DiscoveredTool[]> {
    const generation = this.generation(key);
    const activeRefresh = this.activeRefresh(key);
    if (activeRefresh) return activeRefresh;

    const refresh = load()
      .then((tools) => {
        if (this.generation(key) === generation) {
          this.failures.delete(key);
          this.store(key, {
            tools,
            freshUntil: this.now() + this.options.freshnessMs,
            failureCount: 0,
            nextRetryAt: 0,
          });
        }
        return tools;
      })
      .catch((error: unknown) => {
        this.recordFailure(key, generation);
        throw error;
      })
      .finally(() => {
        this.finishRefresh(key, generation, refresh);
      });
    const activeRefreshes = this.refreshes.get(key) ?? new Map<number, Promise<readonly DiscoveredTool[]>>();
    activeRefreshes.set(generation, refresh);
    this.refreshes.set(key, activeRefreshes);
    return refresh;
  }

  private activeRefresh(key: string): Promise<readonly DiscoveredTool[]> | undefined {
    return this.refreshes.get(key)?.get(this.generation(key));
  }

  private recordFailure(key: string, generation: number): void {
    if (this.generation(key) !== generation) return;
    const entry = this.entries.get(key);
    const failureCount = entry
      ? entry.failureCount + 1
      : (this.failures.get(key)?.failureCount ?? 0) + 1;
    const retryMs = Math.min(
      this.options.initialRetryMs * 2 ** (failureCount - 1),
      this.options.maxRetryMs,
    );
    const nextRetryAt = this.now() + retryMs;
    if (entry) {
      this.store(key, { ...entry, failureCount, nextRetryAt });
      return;
    }
    this.failures.delete(key);
    this.failures.set(key, { failureCount, nextRetryAt });
    while (this.failures.size > this.options.maxEntries) {
      const oldestKey = this.failures.keys().next().value;
      if (oldestKey === undefined) return;
      this.failures.delete(oldestKey);
      this.supersedeActiveRefreshes(oldestKey);
    }
  }

  private generation(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  private store(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.options.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) return;
      this.entries.delete(oldestKey);
      this.supersedeActiveRefreshes(oldestKey);
    }
  }

  private supersedeActiveRefreshes(key: string): void {
    if (this.refreshes.has(key)) {
      this.generations.set(key, this.generation(key) + 1);
      return;
    }
    this.generations.delete(key);
  }

  private finishRefresh(
    key: string,
    generation: number,
    refresh: Promise<readonly DiscoveredTool[]>,
  ): void {
    const activeRefreshes = this.refreshes.get(key);
    if (activeRefreshes?.get(generation) === refresh) activeRefreshes.delete(generation);
    if (activeRefreshes?.size === 0) this.refreshes.delete(key);
    if (!this.entries.has(key) && !this.failures.has(key) && !this.refreshes.has(key)) {
      this.generations.delete(key);
    }
  }

  private touch(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private freshHint(freshForMs = this.options.freshnessMs): ToolCacheHint {
    return { state: 'fresh', freshForMs, nextCheckInMs: freshForMs };
  }

  private revalidatingHint(): ToolCacheHint {
    return { state: 'revalidating', freshForMs: 0, nextCheckInMs: this.options.revalidationPollMs };
  }

  private refreshFailedHint(nextCheckInMs: number): ToolCacheHint {
    return { state: 'refresh_failed', freshForMs: 0, nextCheckInMs };
  }
}

export class ToolDiscoveryBackoffError extends Error {
  constructor(readonly cache: ToolCacheHint) {
    super('Tool discovery refresh is waiting for retry backoff');
    this.name = 'ToolDiscoveryBackoffError';
  }
}

export function aggregateToolCacheHints(hints: readonly ToolCacheHint[]): ToolCacheHint {
  if (hints.length === 0) {
    return {
      state: 'fresh',
      freshForMs: TOOL_DISCOVERY_FRESHNESS_MS,
      nextCheckInMs: TOOL_DISCOVERY_FRESHNESS_MS,
    };
  }
  const state = hints.some((hint) => hint.state === 'revalidating')
    ? 'revalidating'
    : hints.some((hint) => hint.state === 'refresh_failed') ? 'refresh_failed' : 'fresh';
  return {
    state,
    freshForMs: Math.min(...hints.map((hint) => hint.freshForMs)),
    nextCheckInMs: Math.min(...hints.map((hint) => hint.nextCheckInMs)),
  };
}

export function failedToolCacheHint(): ToolCacheHint {
  return {
    state: 'refresh_failed',
    freshForMs: 0,
    nextCheckInMs: TOOL_DISCOVERY_INITIAL_RETRY_MS,
  };
}

export function toolCacheHintFromError(error: unknown): ToolCacheHint {
  return error instanceof ToolDiscoveryBackoffError ? error.cache : failedToolCacheHint();
}

export const TOOL_DISCOVERY_CACHE_OPTIONS = {
  freshnessMs: TOOL_DISCOVERY_FRESHNESS_MS,
  revalidationPollMs: TOOL_DISCOVERY_REVALIDATION_POLL_MS,
  initialRetryMs: TOOL_DISCOVERY_INITIAL_RETRY_MS,
  maxRetryMs: TOOL_DISCOVERY_MAX_RETRY_MS,
  maxEntries: TOOL_DISCOVERY_MAX_ENTRIES,
} as const;
