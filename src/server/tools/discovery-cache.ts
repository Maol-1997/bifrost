import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Tool } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { PROVIDER_REGISTRY, SUPPORTED_APPS } from '../providers/registry.js';
import type { ProviderId } from '../providers/types.js';
import { mcpToolNameSchema, normalizeUpstreamTool, type DiscoveredTool, type ToolContractSnapshot } from './catalog.js';
import { parseToolCacheGeneration, type ToolCacheStore } from './cache-store.js';

/**
 * Every worker shares one key space, so the version segment is what lets the
 * shape of an entry change without a half-deployed cluster serving each other
 * records it cannot read.
 */
const TOOL_CACHE_KEY_PREFIX = 'bifrost:v1:tools';
const TOOL_DISCOVERY_FRESHNESS_MS = 60 * 60 * 1_000;
/** How long a stale listing stays worth serving while refreshes are attempted. */
const TOOL_DISCOVERY_RETENTION_MS = 24 * 60 * 60 * 1_000;
const TOOL_DISCOVERY_REVALIDATION_POLL_MS = 3_000;
const TOOL_DISCOVERY_INITIAL_RETRY_MS = 5_000;
const TOOL_DISCOVERY_MAX_RETRY_MS = 5 * 60 * 1_000;
/** Long enough to cover a slow upstream listing, short enough to survive a crash. */
const TOOL_DISCOVERY_REFRESH_LOCK_MS = 30_000;
// A generation has to outlive every entry that quotes it. If it expired first,
// the next invalidation would count up from one again and a write from an older
// generation could land looking current.
const TOOL_DISCOVERY_GENERATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const TOOL_DISCOVERY_COLD_WAIT_MS = TOOL_DISCOVERY_REFRESH_LOCK_MS;
const TOOL_DISCOVERY_COLD_POLL_MS = 150;
const MAX_DECODED_ENTRIES = 256;

type ToolCacheState = 'fresh' | 'revalidating' | 'refresh_failed';

export type ToolCacheHint = {
  state: ToolCacheState;
  freshForMs: number;
  nextCheckInMs: number;
};

export type CachedToolDiscovery = {
  tools: readonly DiscoveredTool[];
  cache: ToolCacheHint;
};

/** One provider's tools for one person; nothing is ever cached across users. */
export type ToolCacheKey = {
  userId: string;
  providerId: ProviderId;
};

export type ToolLoader = () => Promise<readonly DiscoveredTool[]>;

export type ToolCacheLoaders = {
  blocking: ToolLoader;
  /**
   * Separate from `blocking` because a background revalidation outlives the
   * request that noticed the staleness and must not inherit its abort signal.
   */
  background: ToolLoader;
};

export type ToolDiscoveryCacheDependencies = {
  store: ToolCacheStore;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  onBackgroundError?: (error: unknown) => void;
  onUnreadableEntry?: (error: unknown) => void;
};

export type ToolDiscoveryCacheOptions = {
  freshnessMs: number;
  retentionMs: number;
  revalidationPollMs: number;
  initialRetryMs: number;
  maxRetryMs: number;
  refreshLockMs: number;
  generationTtlMs: number;
  coldWaitMs: number;
  coldPollMs: number;
};

export const TOOL_DISCOVERY_CACHE_OPTIONS: ToolDiscoveryCacheOptions = {
  freshnessMs: TOOL_DISCOVERY_FRESHNESS_MS,
  retentionMs: TOOL_DISCOVERY_RETENTION_MS,
  revalidationPollMs: TOOL_DISCOVERY_REVALIDATION_POLL_MS,
  initialRetryMs: TOOL_DISCOVERY_INITIAL_RETRY_MS,
  maxRetryMs: TOOL_DISCOVERY_MAX_RETRY_MS,
  refreshLockMs: TOOL_DISCOVERY_REFRESH_LOCK_MS,
  generationTtlMs: TOOL_DISCOVERY_GENERATION_TTL_MS,
  coldWaitMs: TOOL_DISCOVERY_COLD_WAIT_MS,
  coldPollMs: TOOL_DISCOVERY_COLD_POLL_MS,
};

/**
 * Only the upstream contract is stored. A tool's Bifrost name, title,
 * mutability and fingerprint are all derived from that contract on the way out,
 * so a corrupted or tampered entry cannot hand back a fingerprint that an
 * approved deployment policy would accept. Credentials are never part of it.
 */
const cachedContractSchema = z.object({
  providerId: z.enum(SUPPORTED_APPS),
  tool: z.looseObject({ name: z.string().min(1) }),
});

const cacheRecordSchema = z.object({
  generation: z.number().int().nonnegative(),
  // Null separates "the last attempt failed" from "this provider genuinely
  // exposes no tools".
  contracts: z.array(cachedContractSchema).nullable(),
  freshUntil: z.number().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  nextRetryAt: z.number().nonnegative(),
});

type CachedContract = z.infer<typeof cachedContractSchema>;

type CacheRecord = {
  generation: number;
  contracts: readonly ToolContractSnapshot[] | null;
  freshUntil: number;
  failureCount: number;
  nextRetryAt: number;
};

type CacheEntry = {
  /** Undefined when the record carries only failure backoff. */
  tools: readonly DiscoveredTool[] | undefined;
  freshUntil: number;
  failureCount: number;
  nextRetryAt: number;
};

type CacheState = {
  generation: number;
  entry: CacheEntry | undefined;
};

export function toolCacheKey(key: ToolCacheKey, part: 'generation' | 'entry-prefix'): string;
export function toolCacheKey(key: ToolCacheKey, part: 'entry' | 'refresh', generation: number): string;
export function toolCacheKey(
  key: ToolCacheKey,
  part: 'generation' | 'entry-prefix' | 'entry' | 'refresh',
  generation?: number,
): string {
  const suffix = part === 'entry-prefix' ? 'entry:' : part;
  const prefix = `${TOOL_CACHE_KEY_PREFIX}:${key.userId}:${key.providerId}:${suffix}`;
  return part === 'generation' || part === 'entry-prefix' ? prefix : `${prefix}:${generation}`;
}

export class ToolDiscoveryCache {
  private readonly store: ToolCacheStore;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly onBackgroundError: ((error: unknown) => void) | undefined;
  private readonly onUnreadableEntry: ((error: unknown) => void) | undefined;
  private readonly blockingLoads = new Map<string, Promise<readonly DiscoveredTool[]>>();
  private readonly backgroundRefreshes = new Set<string>();
  // Exact-byte hits skip JSON parsing, validation and contract hashing. Store
  // snapshots and generation checks still run, so another worker can invalidate
  // or replace the record without waiting for a local cache lifetime.
  private readonly decoded = new Map<string, { raw: string; entry: CacheEntry }>();

  constructor(
    dependencies: ToolDiscoveryCacheDependencies,
    private readonly options: ToolDiscoveryCacheOptions = TOOL_DISCOVERY_CACHE_OPTIONS,
  ) {
    this.store = dependencies.store;
    this.now = dependencies.now ?? Date.now;
    this.delay = dependencies.delay ?? ((ms) => sleep(ms));
    this.onBackgroundError = dependencies.onBackgroundError;
    this.onUnreadableEntry = dependencies.onUnreadableEntry;
  }

  async read(key: ToolCacheKey, loaders: ToolCacheLoaders): Promise<CachedToolDiscovery> {
    const { generation, entry } = await this.readState(key);
    const now = this.now();

    if (entry?.tools) {
      if (now < entry.freshUntil) return { tools: entry.tools, cache: this.freshHint(entry.freshUntil - now) };
      if (now < entry.nextRetryAt) {
        return { tools: entry.tools, cache: refreshFailedHint(entry.nextRetryAt - now) };
      }
      this.revalidate(key, generation, entry, loaders.background);
      return { tools: entry.tools, cache: this.revalidatingHint() };
    }

    if (entry && now < entry.nextRetryAt) {
      throw new ToolDiscoveryBackoffError(refreshFailedHint(entry.nextRetryAt - now));
    }
    const tools = await this.loadBlocking(key, generation, entry, loaders.blocking);
    return { tools, cache: this.freshHint() };
  }

  /**
   * Bypasses the entry entirely. Approving a policy is a decision about a
   * definition the admin just read, so it has to be taken against a live
   * listing — and the result becomes what every other worker then serves.
   */
  async readFresh(key: ToolCacheKey, load: ToolLoader): Promise<CachedToolDiscovery> {
    const { generation, entry } = await this.readState(key);
    try {
      const tools = await load();
      await this.writeSuccess(key, generation, tools);
      return { tools, cache: this.freshHint() };
    } catch (error) {
      await this.writeFailure(key, generation, entry);
      throw error;
    }
  }

  async invalidate(key: ToolCacheKey): Promise<void> {
    // Each entry and refresh lock is tied to its generation. A refresh already
    // in flight can finish, but no later request can observe its old key.
    await this.store.increment(toolCacheKey(key, 'generation'), this.options.generationTtlMs);
  }

  private async readState(key: ToolCacheKey): Promise<CacheState> {
    const snapshot = await this.store.readSnapshot({
      generationKey: toolCacheKey(key, 'generation'),
      entryKeyPrefix: toolCacheKey(key, 'entry-prefix'),
    });
    const generation = parseToolCacheGeneration(snapshot.generationBefore);
    if (parseToolCacheGeneration(snapshot.generationAfter) !== generation) return this.readState(key);
    const entryKey = toolCacheKey(key, 'entry', generation);
    const rawRecord = snapshot.value;
    if (rawRecord === undefined) return { generation, entry: undefined };

    const memo = this.decoded.get(entryKey);
    if (memo?.raw === rawRecord) {
      if (memo.entry.tools && this.now() >= memo.entry.freshUntil + this.options.retentionMs) {
        return this.discard(key, generation);
      }
      return { generation, entry: memo.entry };
    }

    const record = this.parseRecord(rawRecord);
    if (!record) return this.discard(key, generation);
    // A record left behind by a superseded generation is exactly what
    // invalidation exists to reject.
    if (record.generation !== generation) return { generation, entry: undefined };

    const timings = {
      freshUntil: record.freshUntil,
      failureCount: record.failureCount,
      nextRetryAt: record.nextRetryAt,
    };
    if (!record.contracts) return { generation, entry: { tools: undefined, ...timings } };
    if (this.now() >= record.freshUntil + this.options.retentionMs) {
      return this.discard(key, generation);
    }
    const tools = this.decodeTools(key.providerId, record.contracts);
    if (!tools) return this.discard(key, generation);
    const entry = { tools, ...timings };
    this.rememberDecoded(entryKey, rawRecord, entry);
    return { generation, entry };
  }

  /**
   * An entry nobody can read is worse than no entry: left in place it would
   * make every request pay for the same failed decode until it expired.
   */
  private async discard(key: ToolCacheKey, generation: number): Promise<CacheState> {
    const entryKey = toolCacheKey(key, 'entry', generation);
    this.decoded.delete(entryKey);
    await this.store.remove(entryKey);
    return { generation, entry: undefined };
  }

  private parseRecord(rawRecord: string): z.infer<typeof cacheRecordSchema> | undefined {
    try {
      const record = cacheRecordSchema.safeParse(JSON.parse(rawRecord));
      if (record.success) return record.data;
      this.onUnreadableEntry?.(record.error);
    } catch (error) {
      this.onUnreadableEntry?.(error);
    }
    return undefined;
  }

  private decodeTools(
    providerId: ProviderId,
    contracts: readonly CachedContract[],
  ): readonly DiscoveredTool[] | undefined {
    try {
      return contracts.map((contract) => decodeTool(providerId, contract));
    } catch (error) {
      this.onUnreadableEntry?.(error);
      return undefined;
    }
  }

  private rememberDecoded(memoKey: string, raw: string, entry: CacheEntry): void {
    this.decoded.delete(memoKey);
    this.decoded.set(memoKey, { raw, entry });
    while (this.decoded.size > MAX_DECODED_ENTRIES) {
      const oldestKey = this.decoded.keys().next().value;
      if (oldestKey === undefined) return;
      this.decoded.delete(oldestKey);
    }
  }

  private async loadBlocking(
    key: ToolCacheKey,
    generation: number,
    entry: CacheEntry | undefined,
    load: ToolLoader,
  ): Promise<readonly DiscoveredTool[]> {
    const lockKey = toolCacheKey(key, 'refresh', generation);
    const inFlight = this.blockingLoads.get(lockKey);
    if (inFlight) return inFlight;

    const started = this.runBlockingLoad(key, generation, entry, load, lockKey);
    this.blockingLoads.set(lockKey, started);
    try {
      return await started;
    } finally {
      if (this.blockingLoads.get(lockKey) === started) this.blockingLoads.delete(lockKey);
    }
  }

  private async runBlockingLoad(
    key: ToolCacheKey,
    generation: number,
    entry: CacheEntry | undefined,
    load: ToolLoader,
    lockKey: string,
  ): Promise<readonly DiscoveredTool[]> {
    const owner = randomUUID();
    const locked = await this.store.writeIfAbsent(lockKey, owner, this.options.refreshLockMs);
    if (!locked) {
      const shared = await this.waitForEntry(key, generation);
      // A caller with nothing to serve cannot wait out a thirty second lock, so
      // once the short window closes it listens upstream itself rather than fail.
      if (shared) return shared;
    }
    try {
      const tools = await load();
      await this.writeSuccess(key, generation, tools);
      return tools;
    } catch (error) {
      await this.writeFailure(key, generation, entry);
      throw error;
    } finally {
      if (locked) await this.store.removeIfEqual(lockKey, owner);
    }
  }

  private async waitForEntry(
    key: ToolCacheKey,
    expectedGeneration: number,
  ): Promise<readonly DiscoveredTool[] | undefined> {
    const attempts = Math.max(1, Math.ceil(this.options.coldWaitMs / this.options.coldPollMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await this.delay(this.options.coldPollMs);
      const { generation, entry } = await this.readState(key);
      if (generation !== expectedGeneration) return undefined;
      if (entry?.tools) return entry.tools;
      const now = this.now();
      // The worker holding the lock failed. Piling on would turn one provider
      // outage into a stampede against it.
      if (entry && now < entry.nextRetryAt) {
        throw new ToolDiscoveryBackoffError(refreshFailedHint(entry.nextRetryAt - now));
      }
    }
    return undefined;
  }

  private revalidate(key: ToolCacheKey, generation: number, entry: CacheEntry, load: ToolLoader): void {
    const lockKey = toolCacheKey(key, 'refresh', generation);
    if (this.backgroundRefreshes.has(lockKey)) return;
    this.backgroundRefreshes.add(lockKey);
    void this.runBackgroundRefresh(key, generation, entry, load, lockKey)
      .catch((error: unknown) => {
        this.onBackgroundError?.(error);
      })
      .finally(() => {
        this.backgroundRefreshes.delete(lockKey);
      });
  }

  private async runBackgroundRefresh(
    key: ToolCacheKey,
    generation: number,
    entry: CacheEntry,
    load: ToolLoader,
    lockKey: string,
  ): Promise<void> {
    const owner = randomUUID();
    // Another worker already owns this refresh; a second upstream round trip
    // would buy nothing, and the stale answer is already on its way out.
    if (!(await this.store.writeIfAbsent(lockKey, owner, this.options.refreshLockMs))) return;
    try {
      await this.writeSuccess(key, generation, await load());
    } catch (error) {
      await this.writeFailure(key, generation, entry);
      throw error;
    } finally {
      await this.store.removeIfEqual(lockKey, owner);
    }
  }

  private async writeSuccess(key: ToolCacheKey, generation: number, tools: readonly DiscoveredTool[]): Promise<void> {
    await this.writeRecord(key, {
      generation,
      contracts: tools.map((tool) => tool.contract),
      freshUntil: this.now() + this.options.freshnessMs,
      failureCount: 0,
      nextRetryAt: 0,
    });
  }

  private async writeFailure(key: ToolCacheKey, generation: number, entry: CacheEntry | undefined): Promise<void> {
    const now = this.now();
    const failureCount = (entry?.failureCount ?? 0) + 1;
    const backoffMs = Math.min(this.options.initialRetryMs * 2 ** (failureCount - 1), this.options.maxRetryMs);
    const canRetainStaleTools = entry?.tools !== undefined && now < entry.freshUntil + this.options.retentionMs;
    await this.writeRecord(key, {
      generation,
      contracts: canRetainStaleTools ? (entry.tools?.map((tool) => tool.contract) ?? null) : null,
      freshUntil: canRetainStaleTools ? entry.freshUntil : 0,
      failureCount,
      nextRetryAt: now + backoffMs,
    });
  }

  private async writeRecord(key: ToolCacheKey, record: CacheRecord): Promise<void> {
    const entryKey = toolCacheKey(key, 'entry', record.generation);
    // Checking the generation on both sides of the write closes the window one
    // check leaves open: a bump before it makes the write pointless, and a bump
    // after it leaves behind an entry only this caller still knows to remove.
    if ((await this.readGeneration(key)) !== record.generation) return;
    const now = this.now();
    const expiresAt = record.contracts
      ? record.freshUntil + this.options.retentionMs
      : record.nextRetryAt + this.options.maxRetryMs;
    await this.store.write(entryKey, JSON.stringify(record), Math.max(1, expiresAt - now));
    if ((await this.readGeneration(key)) !== record.generation) await this.store.remove(entryKey);
  }

  private async readGeneration(key: ToolCacheKey): Promise<number> {
    return parseToolCacheGeneration(await this.store.read(toolCacheKey(key, 'generation')));
  }

  private freshHint(freshForMs = this.options.freshnessMs): ToolCacheHint {
    return { state: 'fresh', freshForMs, nextCheckInMs: freshForMs };
  }

  private revalidatingHint(): ToolCacheHint {
    return { state: 'revalidating', freshForMs: 0, nextCheckInMs: this.options.revalidationPollMs };
  }
}

class ToolDiscoveryBackoffError extends Error {
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
    : hints.some((hint) => hint.state === 'refresh_failed')
      ? 'refresh_failed'
      : 'fresh';
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

function refreshFailedHint(nextCheckInMs: number): ToolCacheHint {
  return { state: 'refresh_failed', freshForMs: 0, nextCheckInMs };
}

function decodeTool(providerId: ProviderId, contract: CachedContract): DiscoveredTool {
  if (contract.providerId !== providerId) {
    throw new Error(`Cached tool contract belongs to ${contract.providerId}, not ${providerId}`);
  }
  const provider = PROVIDER_REGISTRY.find((entry) => entry.id === providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  const tool = normalizeUpstreamTool(provider, contract.tool as Tool);
  if (!mcpToolNameSchema.safeParse(tool.name).success) {
    throw new Error(`Cached tool has an unusable Bifrost name: ${tool.name}`);
  }
  return tool;
}
