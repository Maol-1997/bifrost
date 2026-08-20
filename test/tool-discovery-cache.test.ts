import { describe, expect, it, vi } from 'vitest';
import { ToolDiscoveryCache, aggregateToolCacheHints } from '../src/server/tools/discovery-cache.js';
import type { DiscoveredTool } from '../src/server/tools/catalog.js';

const tool = { name: 'github_example' } as DiscoveredTool;

function cacheAt(
  clock: { now: number },
  options: { maxEntries?: number; onBackgroundError?: (error: unknown) => void } = {},
): ToolDiscoveryCache {
  return new ToolDiscoveryCache({
    freshnessMs: 3_600_000,
    revalidationPollMs: 3_000,
    initialRetryMs: 5_000,
    maxRetryMs: 300_000,
    maxEntries: options.maxEntries ?? 100,
    now: () => clock.now,
    ...(options.onBackgroundError ? { onBackgroundError: options.onBackgroundError } : {}),
  });
}

function cacheMetadataSizes(cache: ToolDiscoveryCache): { entries: number; generations: number } {
  const internals = cache as unknown as {
    entries: ReadonlyMap<string, unknown>;
    generations: ReadonlyMap<string, unknown>;
  };
  return { entries: internals.entries.size, generations: internals.generations.size };
}

describe('tool discovery SWR cache', () => {
  it('blocks on a cold miss and reports the full fresh lifetime', async () => {
    const clock = { now: 1_000 };
    const load = vi.fn(async () => [tool]);

    const result = await cacheAt(clock).read('user:github', { blocking: load, background: load });

    expect(result).toEqual({
      tools: [tool],
      cache: { state: 'fresh', freshForMs: 3_600_000, nextCheckInMs: 3_600_000 },
    });
    expect(load).toHaveBeenCalledOnce();
  });

  it('returns fresh data without loading and exposes only the remaining lifetime', async () => {
    const clock = { now: 1_000 };
    const load = vi.fn(async () => [tool]);
    const cache = cacheAt(clock);
    await cache.read('user:github', { blocking: load, background: load });
    clock.now += 600_000;

    const result = await cache.read('user:github', { blocking: load, background: load });

    expect(result.cache).toEqual({ state: 'fresh', freshForMs: 3_000_000, nextCheckInMs: 3_000_000 });
    expect(load).toHaveBeenCalledOnce();
  });

  it('returns stale immediately and deduplicates background revalidation', async () => {
    const clock = { now: 1_000 };
    let finishRefresh: ((tools: readonly DiscoveredTool[]) => void) | undefined;
    const blocking = vi.fn(async () => [tool]);
    const background = vi.fn(() => new Promise<readonly DiscoveredTool[]>((resolve) => { finishRefresh = resolve; }));
    const cache = cacheAt(clock);
    await cache.read('user:github', { blocking, background });
    clock.now += 3_600_000;

    const first = await cache.read('user:github', { blocking, background });
    const second = await cache.read('user:github', { blocking, background });

    expect(first.cache).toEqual({ state: 'revalidating', freshForMs: 0, nextCheckInMs: 3_000 });
    expect(second.cache).toEqual(first.cache);
    expect(background).toHaveBeenCalledOnce();
    finishRefresh?.([tool]);
    await cache.readFresh('user:github', background);
  });

  it('keeps stale data and backs off after a failed revalidation', async () => {
    const clock = { now: 1_000 };
    const onError = vi.fn();
    const blocking = vi.fn(async () => [tool]);
    const failure = new Error('provider down');
    const background = vi.fn(async () => Promise.reject(failure));
    const cache = cacheAt(clock, { onBackgroundError: onError });
    await cache.read('user:github', { blocking, background });
    clock.now += 3_600_000;
    await cache.read('user:github', { blocking, background });
    await vi.waitFor(() => { expect(onError).toHaveBeenCalledWith(failure); });

    const result = await cache.read('user:github', { blocking, background });

    expect(result.tools).toEqual([tool]);
    expect(result.cache).toEqual({ state: 'refresh_failed', freshForMs: 0, nextCheckInMs: 5_000 });
    expect(background).toHaveBeenCalledOnce();
  });

  it('backs off cold failures instead of repeatedly hitting an unavailable provider', async () => {
    const clock = { now: 1_000 };
    const failure = new Error('provider down');
    const load = vi.fn(async () => Promise.reject(failure));
    const cache = cacheAt(clock);
    await expect(cache.read('user:github', { blocking: load, background: load })).rejects.toBe(failure);

    await expect(cache.read('user:github', { blocking: load, background: load })).rejects.toMatchObject({
      cache: { state: 'refresh_failed', freshForMs: 0, nextCheckInMs: 5_000 },
    });
    expect(load).toHaveBeenCalledOnce();

    clock.now += 5_000;
    await expect(cache.read('user:github', { blocking: load, background: load })).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidating during a refresh prevents the old result from repopulating the cache', async () => {
    const clock = { now: 1_000 };
    let finishLoad: ((tools: readonly DiscoveredTool[]) => void) | undefined;
    const delayedLoad = vi.fn(() => new Promise<readonly DiscoveredTool[]>((resolve) => { finishLoad = resolve; }));
    const cache = cacheAt(clock);
    const firstRead = cache.read('user:github', { blocking: delayedLoad, background: delayedLoad });
    cache.invalidate('user:github');
    const replacementLoad = vi.fn(async () => []);
    const replacementRead = cache.read('user:github', { blocking: replacementLoad, background: replacementLoad });
    finishLoad?.([tool]);
    await firstRead;
    const result = await replacementRead;

    expect(result.tools).toEqual([]);
    expect(replacementLoad).toHaveBeenCalledOnce();
  });

  it('keeps tracking an older refresh after its replacement completes', async () => {
    const clock = { now: 1_000 };
    const cache = cacheAt(clock);
    let finishOldLoad: ((tools: readonly DiscoveredTool[]) => void) | undefined;
    const oldLoad = vi.fn(() => new Promise<readonly DiscoveredTool[]>((resolve) => {
      finishOldLoad = resolve;
    }));
    const oldRead = cache.read('user:github', { blocking: oldLoad, background: oldLoad });
    cache.invalidate('user:github');
    await cache.read('user:github', { blocking: async () => [], background: async () => [] });
    cache.invalidate('user:github');

    finishOldLoad?.([tool]);
    await oldRead;
    const currentLoad = vi.fn(async () => []);
    const result = await cache.read('user:github', { blocking: currentLoad, background: currentLoad });

    expect(result.tools).toEqual([]);
    expect(currentLoad).toHaveBeenCalledOnce();
  });

  it('removes generation metadata after invalidating settled state', async () => {
    const clock = { now: 1_000 };
    const cache = cacheAt(clock);
    await cache.read('user:github', { blocking: async () => [tool], background: async () => [tool] });

    cache.invalidate('user:github');

    expect(cacheMetadataSizes(cache)).toEqual({ entries: 0, generations: 0 });
  });

  it('bounds entries and generation metadata under key churn', async () => {
    const clock = { now: 1_000 };
    const cache = cacheAt(clock, { maxEntries: 2 });
    const load = vi.fn(async () => [tool]);

    for (let index = 0; index < 10; index += 1) {
      await cache.read(`user:${index}`, { blocking: load, background: load });
    }

    expect(cacheMetadataSizes(cache)).toEqual({ entries: 2, generations: 0 });
  });

  it('does not let an evicted stale refresh repopulate the cache', async () => {
    const clock = { now: 1_000 };
    const cache = cacheAt(clock, { maxEntries: 1 });
    let finishStaleRefresh: ((tools: readonly DiscoveredTool[]) => void) | undefined;
    const firstLoad = vi.fn(async () => [tool]);
    const staleRefresh = vi.fn(() => new Promise<readonly DiscoveredTool[]>((resolve) => {
      finishStaleRefresh = resolve;
    }));
    await cache.read('user:github', { blocking: firstLoad, background: staleRefresh });
    clock.now += 3_600_000;
    await cache.read('user:github', { blocking: firstLoad, background: staleRefresh });
    await cache.read('user:linear', { blocking: async () => [], background: async () => [] });

    finishStaleRefresh?.([tool]);
    await vi.waitFor(() => { expect(cacheMetadataSizes(cache).generations).toBe(0); }, { interval: 1 });
    const replacementLoad = vi.fn(async () => []);
    const result = await cache.read('user:github', { blocking: replacementLoad, background: replacementLoad });

    expect(result.tools).toEqual([]);
    expect(replacementLoad).toHaveBeenCalledOnce();
  });

  it('aggregates using the earliest lifetime and most urgent state', () => {
    expect(aggregateToolCacheHints([
      { state: 'fresh', freshForMs: 30_000, nextCheckInMs: 30_000 },
      { state: 'refresh_failed', freshForMs: 0, nextCheckInMs: 8_000 },
      { state: 'revalidating', freshForMs: 0, nextCheckInMs: 3_000 },
    ])).toEqual({ state: 'revalidating', freshForMs: 0, nextCheckInMs: 3_000 });
  });
});
