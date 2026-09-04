import type { Tool } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { PROVIDER_REGISTRY } from '../src/server/providers/registry.js';
import type { ProviderDefinition } from '../src/server/providers/types.js';
import {
  fingerprintToolDefinition,
  normalizeUpstreamTool,
  type DiscoveredTool,
} from '../src/server/tools/catalog.js';
import {
  createInMemoryToolCacheStore,
  type ToolCacheStore,
} from '../src/server/tools/cache-store.js';
import {
  aggregateToolCacheHints,
  toolCacheKey,
  ToolDiscoveryCache,
  TOOL_DISCOVERY_CACHE_OPTIONS,
  type ToolCacheKey,
  type ToolDiscoveryCacheOptions,
} from '../src/server/tools/discovery-cache.js';

const github: ProviderDefinition = PROVIDER_REGISTRY.find((provider) => provider.id === 'github')!;
const definition: Tool = {
  name: 'get_issue',
  title: 'Get issue',
  description: 'Read an issue.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};
const tool = normalizeUpstreamTool(github, definition);
const otherTool = normalizeUpstreamTool(github, { ...definition, name: 'list_issues' });
const key: ToolCacheKey = { userId: '11111111-1111-4111-8111-111111111111', providerId: 'github' };

type CacheHarness = {
  clock: { now: number };
  store: ToolCacheStore;
  cache: ToolDiscoveryCache;
  backgroundErrors: ReturnType<typeof vi.fn>;
  unreadableEntries: ReturnType<typeof vi.fn>;
  delay: ReturnType<typeof vi.fn>;
};

function harness(overrides: {
  store?: ToolCacheStore;
  clock?: { now: number };
  options?: Partial<ToolDiscoveryCacheOptions>;
  delay?: () => Promise<void>;
} = {}): CacheHarness {
  const clock = overrides.clock ?? { now: 1_000 };
  const store = overrides.store ?? createInMemoryToolCacheStore({ now: () => clock.now });
  const backgroundErrors = vi.fn();
  const unreadableEntries = vi.fn();
  const delay = vi.fn(overrides.delay ?? (async () => undefined));
  const cache = new ToolDiscoveryCache({
    store,
    now: () => clock.now,
    delay,
    onBackgroundError: backgroundErrors,
    onUnreadableEntry: unreadableEntries,
  }, { ...TOOL_DISCOVERY_CACHE_OPTIONS, ...overrides.options });
  return { clock, store, cache, backgroundErrors, unreadableEntries, delay };
}

function loaders(load: () => Promise<readonly DiscoveredTool[]>) {
  return { blocking: load, background: load };
}

async function storedRecord(store: ToolCacheStore): Promise<Record<string, unknown>> {
  const raw = await store.read(toolCacheKey(key, 'entry', 0));
  return JSON.parse(raw ?? '{}') as Record<string, unknown>;
}

describe('shared tool discovery cache', () => {
  it('blocks on a cold miss and reports the full fresh lifetime', async () => {
    const { cache } = harness();
    const load = vi.fn(async () => [tool]);

    const result = await cache.read(key, loaders(load));

    expect(result).toEqual({
      tools: [tool],
      cache: { state: 'fresh', freshForMs: 3_600_000, nextCheckInMs: 3_600_000 },
    });
    expect(load).toHaveBeenCalledOnce();
  });

  it('serves a fresh entry without loading and exposes only the remaining lifetime', async () => {
    const { cache, clock } = harness();
    const load = vi.fn(async () => [tool]);
    await cache.read(key, loaders(load));
    clock.now += 600_000;

    const result = await cache.read(key, loaders(load));

    expect(result.cache).toEqual({ state: 'fresh', freshForMs: 3_000_000, nextCheckInMs: 3_000_000 });
    expect(load).toHaveBeenCalledOnce();
  });

  it('revalidates changed bytes after warming the decoded entry', async () => {
    const { cache, store } = harness();
    const load = loaders(async () => [tool]);
    await cache.read(key, load);
    await cache.read(key, load);
    const record = await storedRecord(store);
    const changed = { ...definition, description: 'Changed by another worker.' };
    await store.write(toolCacheKey(key, 'entry', 0), JSON.stringify({
      ...record,
      contracts: [{ providerId: 'github', tool: changed }],
    }), 86_400_000);

    const result = await cache.read(key, load);

    expect(result.tools[0]?.fingerprint).toBe(fingerprintToolDefinition('github', changed));
  });

  it('does not let a warmed entry hide corrupt replacement bytes', async () => {
    const { cache, store } = harness();
    await cache.read(key, loaders(async () => [tool]));
    await cache.read(key, loaders(async () => [tool]));
    await store.write(toolCacheKey(key, 'entry', 0), 'not json', 86_400_000);

    const result = await cache.read(key, loaders(async () => [otherTool]));

    expect(result.tools).toEqual([otherTool]);
  });

  it('expires a warmed entry even when the backend retains its bytes', async () => {
    const { cache, store, clock } = harness();
    const load = loaders(async () => [tool]);
    await cache.read(key, load);
    await cache.read(key, load);
    const raw = await store.read(toolCacheKey(key, 'entry', 0));
    await store.write(toolCacheKey(key, 'entry', 0), raw!, 100_000_000);
    clock.now += 3_600_000 + 86_400_000;

    const result = await cache.read(key, loaders(async () => [otherTool]));

    expect(result.tools).toEqual([otherTool]);
  });

  it('does not reuse a warmed entry after another worker advances the generation', async () => {
    const { cache, store } = harness();
    await cache.read(key, loaders(async () => [tool]));
    await cache.read(key, loaders(async () => [tool]));
    const otherWorker = harness({ store }).cache;
    await otherWorker.invalidate(key);

    const result = await cache.read(key, loaders(async () => [otherTool]));

    expect(result.tools).toEqual([otherTool]);
  });

  it('returns stale immediately and deduplicates background revalidation', async () => {
    const { cache, clock } = harness();
    const blocking = vi.fn(async () => [tool]);
    const background = vi.fn(async () => [tool]);
    await cache.read(key, { blocking, background });
    clock.now += 3_600_000;

    const first = await cache.read(key, { blocking, background });
    const second = await cache.read(key, { blocking, background });

    expect(first.cache).toEqual({ state: 'revalidating', freshForMs: 0, nextCheckInMs: 3_000 });
    expect(second.cache).toEqual(first.cache);
    await vi.waitFor(() => { expect(background).toHaveBeenCalledOnce(); });
  });

  it('keeps stale data and backs off after a failed revalidation', async () => {
    const { cache, clock, backgroundErrors } = harness();
    const failure = new Error('provider down');
    const blocking = vi.fn(async () => [tool]);
    const background = vi.fn(async () => Promise.reject(failure));
    await cache.read(key, { blocking, background });
    clock.now += 3_600_000;
    await cache.read(key, { blocking, background });
    await vi.waitFor(() => { expect(backgroundErrors).toHaveBeenCalledWith(failure); });

    const result = await cache.read(key, { blocking, background });

    expect(result.tools).toEqual([tool]);
    expect(result.cache).toEqual({ state: 'refresh_failed', freshForMs: 0, nextCheckInMs: 5_000 });
    expect(background).toHaveBeenCalledOnce();
  });

  it('drops stale data after the retention limit even when failed refreshes keep rewriting it', async () => {
    const { cache, clock, backgroundErrors } = harness({
      options: {
        freshnessMs: 100,
        retentionMs: 1_000,
        initialRetryMs: 100,
        maxRetryMs: 100,
      },
    });
    await cache.read(key, loaders(async () => [tool]));
    const background = vi.fn(async () => Promise.reject(new Error('provider down')));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      clock.now += 100;
      await cache.read(key, { blocking: async () => [tool], background });
      await vi.waitFor(() => { expect(backgroundErrors).toHaveBeenCalledTimes(attempt + 1); });
    }
    clock.now = 2_100;
    const replacement = vi.fn(async () => [otherTool]);

    const result = await cache.read(key, loaders(replacement));

    expect(result.tools).toEqual([otherTool]);
    expect(replacement).toHaveBeenCalledOnce();
  });

  it('backs off cold failures instead of repeatedly hitting an unavailable provider', async () => {
    const { cache, clock } = harness();
    const failure = new Error('provider down');
    const load = vi.fn(async () => Promise.reject(failure));
    await expect(cache.read(key, loaders(load))).rejects.toBe(failure);

    await expect(cache.read(key, loaders(load))).rejects.toMatchObject({
      cache: { state: 'refresh_failed', freshForMs: 0, nextCheckInMs: 5_000 },
    });
    expect(load).toHaveBeenCalledOnce();

    clock.now += 5_000;
    await expect(cache.read(key, loaders(load))).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('doubles the retry delay on each consecutive failure', async () => {
    const { cache, clock } = harness();
    const load = vi.fn(async () => Promise.reject(new Error('provider down')));
    await expect(cache.read(key, loaders(load))).rejects.toThrow('provider down');
    clock.now += 5_000;
    await expect(cache.read(key, loaders(load))).rejects.toThrow('provider down');

    await expect(cache.read(key, loaders(load))).rejects.toMatchObject({
      cache: { state: 'refresh_failed', freshForMs: 0, nextCheckInMs: 10_000 },
    });
  });

  it('caps the retry delay at five minutes', async () => {
    const { cache, clock } = harness();
    const load = vi.fn(async () => Promise.reject(new Error('provider down')));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(cache.read(key, loaders(load))).rejects.toThrow('provider down');
      clock.now += 300_000;
    }
    clock.now -= 300_000;

    await expect(cache.read(key, loaders(load))).rejects.toMatchObject({
      cache: { nextCheckInMs: 300_000 },
    });
  });

  it('invalidating during a refresh keeps the superseded result out of the cache', async () => {
    const { cache } = harness();
    let finishLoad: ((tools: readonly DiscoveredTool[]) => void) | undefined;
    const slowLoad = vi.fn(() => new Promise<readonly DiscoveredTool[]>((resolve) => { finishLoad = resolve; }));
    const firstRead = cache.read(key, loaders(slowLoad));
    await vi.waitFor(() => { expect(finishLoad).toBeDefined(); });
    await cache.invalidate(key);
    finishLoad?.([tool]);
    await firstRead;

    const replacementLoad = vi.fn(async () => [otherTool]);
    const result = await cache.read(key, loaders(replacementLoad));

    expect(result.tools).toEqual([otherTool]);
    expect(replacementLoad).toHaveBeenCalledOnce();
  });

  it('invalidating activates a new empty generation', async () => {
    const { cache, store } = harness();
    await cache.read(key, loaders(async () => [tool]));

    await cache.invalidate(key);

    expect(await store.read(toolCacheKey(key, 'entry', 1))).toBeUndefined();
    expect(await store.read(toolCacheKey(key, 'entry', 0))).toBeDefined();
    expect(await store.read(toolCacheKey(key, 'generation'))).toBe('1');
  });

  it('reloads rather than trusting an entry left behind by an older generation', async () => {
    const { cache, store } = harness();
    await cache.read(key, loaders(async () => [tool]));
    const stale = await store.read(toolCacheKey(key, 'entry', 0)) ?? '';
    await cache.invalidate(key);
    await store.write(toolCacheKey(key, 'entry', 1), stale, 86_400_000);

    const load = vi.fn(async () => [otherTool]);
    const result = await cache.read(key, loaders(load));

    expect(result.tools).toEqual([otherTool]);
    expect(load).toHaveBeenCalledOnce();
  });

  it('discards an entry it cannot parse and reloads', async () => {
    const { cache, store, unreadableEntries } = harness();
    await store.write(toolCacheKey(key, 'entry', 0), 'not json', 86_400_000);
    const load = vi.fn(async () => [tool]);

    const result = await cache.read(key, loaders(load));

    expect(result.tools).toEqual([tool]);
    expect(unreadableEntries).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });

  it('discards an entry whose shape no longer validates', async () => {
    const { cache, store, unreadableEntries } = harness();
    await store.write(toolCacheKey(key, 'entry', 0), JSON.stringify({
      generation: 0,
      contracts: [{ providerId: 'github', tool: { name: '' } }],
      freshUntil: 1,
      failureCount: 0,
      nextRetryAt: 0,
    }), 86_400_000);

    const result = await cache.read(key, loaders(async () => [tool]));

    expect(result.tools).toEqual([tool]);
    expect(unreadableEntries).toHaveBeenCalledOnce();
    expect(await store.read(toolCacheKey(key, 'entry', 0))).toContain('get_issue');
  });

  it('refuses a cached contract that belongs to another provider', async () => {
    const { cache, store, unreadableEntries } = harness();
    await store.write(toolCacheKey(key, 'entry', 0), JSON.stringify({
      generation: 0,
      contracts: [{ providerId: 'linear', tool: { name: 'get_issue' } }],
      freshUntil: 4_000_000,
      failureCount: 0,
      nextRetryAt: 0,
    }), 86_400_000);

    await cache.read(key, loaders(async () => [tool]));

    expect(unreadableEntries).toHaveBeenCalledOnce();
  });

  it('derives the fingerprint from the cached contract, so tampering cannot forge an approval', async () => {
    const { cache, store } = harness();
    const tampered = { ...definition, description: 'Injected after approval.' };
    await store.write(toolCacheKey(key, 'entry', 0), JSON.stringify({
      generation: 0,
      contracts: [{ providerId: 'github', tool: tampered }],
      freshUntil: 4_000_000,
      failureCount: 0,
      nextRetryAt: 0,
    }), 86_400_000);

    const result = await cache.read(key, loaders(async () => [tool]));

    expect(result.tools[0]?.fingerprint).toBe(fingerprintToolDefinition('github', tampered));
    expect(result.tools[0]?.fingerprint).not.toBe(tool.fingerprint);
  });

  it('stores only the upstream contract, never a credential or a derived field', async () => {
    const { cache, store } = harness();
    await cache.read(key, loaders(async () => [tool]));

    const record = await storedRecord(store);

    expect(Object.keys(record).sort()).toEqual(['contracts', 'failureCount', 'freshUntil', 'generation', 'nextRetryAt']);
    expect(record.contracts).toEqual([{ providerId: 'github', tool: tool.contract.tool }]);
    expect(JSON.stringify(record)).not.toContain('fingerprint');
  });

  it('caches a provider that genuinely exposes no tools instead of reloading it', async () => {
    const { cache } = harness();
    const load = vi.fn(async () => []);
    await cache.read(key, loaders(load));

    const result = await cache.read(key, loaders(load));

    expect(result.tools).toEqual([]);
    expect(result.cache.state).toBe('fresh');
    expect(load).toHaveBeenCalledOnce();
  });

  it('reads fresh past a still-fresh entry and republishes the result', async () => {
    const { cache } = harness();
    await cache.read(key, loaders(async () => [tool]));
    const load = vi.fn(async () => [otherTool]);

    const refreshed = await cache.readFresh(key, load);
    const next = await cache.read(key, loaders(async () => [tool]));

    expect(refreshed.cache).toEqual({ state: 'fresh', freshForMs: 3_600_000, nextCheckInMs: 3_600_000 });
    expect(next.tools).toEqual([otherTool]);
    expect(load).toHaveBeenCalledOnce();
  });

  it('records backoff when a fresh read fails', async () => {
    const { cache } = harness();
    const failure = new Error('provider down');

    await expect(cache.readFresh(key, async () => Promise.reject(failure))).rejects.toBe(failure);

    await expect(cache.read(key, loaders(async () => [tool]))).rejects.toMatchObject({
      cache: { state: 'refresh_failed', nextCheckInMs: 5_000 },
    });
  });

  it('deduplicates concurrent cold misses inside one worker', async () => {
    const { cache } = harness();
    let finishLoad: ((tools: readonly DiscoveredTool[]) => void) | undefined;
    const load = vi.fn(() => new Promise<readonly DiscoveredTool[]>((resolve) => { finishLoad = resolve; }));

    const first = cache.read(key, loaders(load));
    const second = cache.read(key, loaders(load));
    await vi.waitFor(() => { expect(finishLoad).toBeDefined(); });
    finishLoad?.([tool]);

    expect((await first).tools).toEqual([tool]);
    expect((await second).tools).toEqual([tool]);
    expect(load).toHaveBeenCalledOnce();
  });

  it('lets only one worker revalidate a shared stale entry', async () => {
    const clock = { now: 1_000 };
    const store = createInMemoryToolCacheStore({ now: () => clock.now });
    const first = harness({ store, clock });
    const second = harness({ store, clock });
    await first.cache.read(key, loaders(async () => [tool]));
    clock.now += 3_600_000;
    const firstBackground = vi.fn(async () => [tool]);
    const secondBackground = vi.fn(async () => [tool]);

    await first.cache.read(key, { blocking: async () => [tool], background: firstBackground });
    await second.cache.read(key, { blocking: async () => [tool], background: secondBackground });

    await vi.waitFor(() => {
      expect(firstBackground.mock.calls.length + secondBackground.mock.calls.length).toBe(1);
    });
  });

  it('waits out a peer refresh on a cold miss rather than duplicating the upstream call', async () => {
    const clock = { now: 1_000 };
    const store = createInMemoryToolCacheStore({ now: () => clock.now });
    const peer = harness({ store, clock });
    await store.writeIfAbsent(toolCacheKey(key, 'refresh', 0), 'peer-worker', 30_000);
    const { cache } = harness({
      store,
      clock,
      delay: async () => { await peer.cache.readFresh(key, async () => [otherTool]); },
    });
    const load = vi.fn(async () => [tool]);

    const result = await cache.read(key, loaders(load));

    expect(result.tools).toEqual([otherTool]);
    expect(load).not.toHaveBeenCalled();
  });

  it('gives up waiting and loads itself when the peer never publishes', async () => {
    const clock = { now: 1_000 };
    const store = createInMemoryToolCacheStore({ now: () => clock.now });
    const { cache, delay } = harness({
      store,
      clock,
      options: { coldWaitMs: 3_000, coldPollMs: 150 },
    });
    await store.writeIfAbsent(toolCacheKey(key, 'refresh', 0), 'peer-worker', 30_000);
    const load = vi.fn(async () => [tool]);

    const result = await cache.read(key, loaders(load));

    expect(result.tools).toEqual([tool]);
    expect(load).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledTimes(20);
  });

  it('honors a peer backoff instead of stampeding an unavailable provider', async () => {
    const clock = { now: 1_000 };
    const store = createInMemoryToolCacheStore({ now: () => clock.now });
    const peer = harness({ store, clock });
    await store.writeIfAbsent(toolCacheKey(key, 'refresh', 0), 'peer-worker', 30_000);
    const { cache } = harness({
      store,
      clock,
      delay: async () => {
        await peer.cache.readFresh(key, async () => Promise.reject(new Error('provider down'))).catch(() => undefined);
      },
    });
    const load = vi.fn(async () => [tool]);

    await expect(cache.read(key, loaders(load))).rejects.toMatchObject({
      cache: { state: 'refresh_failed', nextCheckInMs: 5_000 },
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('namespaces every key by version, user, and provider', () => {
    expect(toolCacheKey(key, 'entry', 7)).toBe(`bifrost:v1:tools:${key.userId}:github:entry:7`);
    expect(toolCacheKey(key, 'generation')).toBe(`bifrost:v1:tools:${key.userId}:github:generation`);
    expect(toolCacheKey(key, 'refresh', 7)).toBe(`bifrost:v1:tools:${key.userId}:github:refresh:7`);
  });

  it('aggregates using the earliest lifetime and most urgent state', () => {
    expect(aggregateToolCacheHints([
      { state: 'fresh', freshForMs: 30_000, nextCheckInMs: 30_000 },
      { state: 'refresh_failed', freshForMs: 0, nextCheckInMs: 8_000 },
      { state: 'revalidating', freshForMs: 0, nextCheckInMs: 3_000 },
    ])).toEqual({ state: 'revalidating', freshForMs: 0, nextCheckInMs: 3_000 });
  });
});

describe('in-process tool cache store', () => {
  it('stops returning a value once its lifetime has passed', async () => {
    const clock = { now: 0 };
    const store = createInMemoryToolCacheStore({ now: () => clock.now });
    await store.write('key', 'value', 1_000);
    clock.now = 999;
    expect(await store.read('key')).toBe('value');

    clock.now = 1_000;

    expect(await store.read('key')).toBeUndefined();
  });

  it('refuses a second writer while a lock is held and admits one after it expires', async () => {
    const clock = { now: 0 };
    const store = createInMemoryToolCacheStore({ now: () => clock.now });

    expect(await store.writeIfAbsent('lock', 'first', 30_000)).toBe(true);
    expect(await store.writeIfAbsent('lock', 'second', 30_000)).toBe(false);

    clock.now = 30_000;
    expect(await store.writeIfAbsent('lock', 'second', 30_000)).toBe(true);
  });

  it('releases a lock only for its owner', async () => {
    const store = createInMemoryToolCacheStore();
    await store.writeIfAbsent('lock', 'owner', 30_000);

    await store.removeIfEqual('lock', 'someone-else');
    expect(await store.read('lock')).toBe('owner');

    await store.removeIfEqual('lock', 'owner');
    expect(await store.read('lock')).toBeUndefined();
  });

  it('counts a generation up from nothing', async () => {
    const store = createInMemoryToolCacheStore();

    expect(await store.increment('generation', 1_000)).toBe(1);
    expect(await store.increment('generation', 1_000)).toBe(2);
  });

  it('bounds the key space under churn', async () => {
    const store = createInMemoryToolCacheStore({ maxEntries: 2 });
    for (let index = 0; index < 10; index += 1) {
      await store.write(`key-${index}`, 'value', 1_000);
    }

    expect(await store.read('key-7')).toBeUndefined();
    expect(await store.read('key-9')).toBe('value');
  });
});
