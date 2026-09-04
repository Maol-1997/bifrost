import { describe, expect, it, vi } from 'vitest';
import { PROVIDER_REGISTRY } from '../src/server/providers/registry.js';
import { normalizeUpstreamTool } from '../src/server/tools/catalog.js';
import { createInMemoryToolCacheStore, createRedisToolCacheStore, type ToolCacheSnapshotKey } from '../src/server/tools/cache-store.js';
import { toolCacheKey, ToolDiscoveryCache } from '../src/server/tools/discovery-cache.js';
import { AtomicRedisFake } from './helpers/atomic-redis.js';

const key = { userId: 'snapshot-user', providerId: 'github' as const };
const snapshotKey: ToolCacheSnapshotKey = { generationKey: toolCacheKey(key, 'generation'), entryKeyPrefix: toolCacheKey(key, 'entry-prefix') };
const provider = PROVIDER_REGISTRY.find((entry) => entry.id === key.providerId)!;
const oldTool = normalizeUpstreamTool(provider, { name: 'get_issue', inputSchema: { type: 'object' } });
const newTool = normalizeUpstreamTool(provider, { name: 'get_issue', description: 'Changed contract', inputSchema: { type: 'object' } });

function record(generation: number, tool = oldTool): string {
  return JSON.stringify({ generation, contracts: [tool.contract], freshUntil: 3_601_000, failureCount: 0, nextRetryAt: 0 });
}

function harness() {
  const redis = new AtomicRedisFake();
  redis.entries.set(snapshotKey.generationKey, '0');
  redis.entries.set(toolCacheKey(key, 'entry', 0), record(0));
  const store = createRedisToolCacheStore(redis);
  const cache = new ToolDiscoveryCache({ store, now: () => 1_000 });
  const load = vi.fn(async () => [newTool]);
  const read = () => cache.read(key, { blocking: load, background: load });
  return { redis, store, cache, load, read };
}

describe('atomic Lua discovery snapshots', () => {
  it('executes generation, entry, generation reads inside the same EVAL', async () => {
    const { redis, store } = harness();

    await store.readSnapshot(snapshotKey);

    expect(redis.reads).toEqual([snapshotKey.generationKey, toolCacheKey(key, 'entry', 0), snapshotKey.generationKey]);
  });

  it('serializes a generation bump attempted between its internal reads', async () => {
    const { redis, store } = harness();
    redis.writeAfterNextGet(() => {
      redis.entries.set(snapshotKey.generationKey, '1');
      redis.entries.set(toolCacheKey(key, 'entry', 1), record(1, newTool));
    });

    const first = await store.readSnapshot(snapshotKey);
    const next = await store.readSnapshot(snapshotKey);

    expect([first, next]).toEqual([
      { generationBefore: '0', value: record(0), generationAfter: '0' },
      { generationBefore: '1', value: record(1, newTool), generationAfter: '1' },
    ]);
  });

  it('retries when a faulty store mutates generation between the Lua reads', async () => {
    const { redis, read, load } = harness();
    redis.corruptAfterNextGet(() => {
      redis.entries.set(snapshotKey.generationKey, '1');
      redis.entries.set(toolCacheKey(key, 'entry', 1), record(1, newTool));
    });

    const result = await read();

    expect({ tools: result.tools, loads: load.mock.calls.length }).toEqual({ tools: [newTool], loads: 0 });
  });

  it('does not let a warmed memo survive an invalidation queued during EVAL', async () => {
    const { redis, read } = harness();
    await read();
    redis.writeAfterNextGet(() => {
      redis.entries.set(snapshotKey.generationKey, '1');
      redis.entries.set(toolCacheKey(key, 'entry', 1), record(1, newTool));
    });

    const inFlight = await read();
    const next = await read();

    expect([inFlight.tools, next.tools]).toEqual([[oldTool], [newTool]]);
  });

  it('serializes a refresh landing mid-read and checks the next snapshot bytes', async () => {
    const { redis, read } = harness();
    await read();
    redis.writeAfterNextGet(() => { redis.entries.set(toolCacheKey(key, 'entry', 0), record(0, newTool)); });

    const inFlight = await read();
    const next = await read();

    expect([inFlight.tools[0]?.fingerprint, next.tools[0]?.fingerprint]).toEqual([oldTool.fingerprint, newTool.fingerprint]);
  });

  it('serializes key removal between the generation read and entry read', async () => {
    const { redis, read, load } = harness();
    await read();
    redis.writeAfterNextGet(() => { redis.entries.delete(toolCacheKey(key, 'entry', 0)); });

    const inFlight = await read();
    const next = await read();

    expect({ first: inFlight.tools, next: next.tools, loads: load.mock.calls.length }).toEqual({ first: [oldTool], next: [newTool], loads: 1 });
  });

  it('treats an entry removed before the snapshot as a miss, not a memo hit', async () => {
    const { redis, read } = harness();
    await read();
    redis.entries.delete(toolCacheKey(key, 'entry', 0));

    expect((await read()).tools).toEqual([newTool]);
  });

  it('keeps the write-side generation recheck when invalidation races publication', async () => {
    const { redis, cache } = harness();
    const entryKey = toolCacheKey(key, 'entry', 0);
    await cache.readFresh(key, async () => {
      redis.writeAfterNextGet(() => { redis.entries.set(snapshotKey.generationKey, '1'); });
      return [newTool];
    });

    expect(redis.entries.get(entryKey)).toBeUndefined();
  });

  it('keeps null slots when no generation or entry exists', async () => {
    const store = createRedisToolCacheStore(new AtomicRedisFake());

    expect(await store.readSnapshot(snapshotKey)).toEqual({ generationBefore: undefined, value: undefined, generationAfter: undefined });
  });

  it.each(['01', '+1', '1suffix', ' 1', 'invalid', '-1', '9007199254740992'])('preserves legacy normalization for noncanonical generation %s', async (raw) => {
    const { redis, store } = harness();
    redis.entries.set(snapshotKey.generationKey, raw);
    redis.entries.set(toolCacheKey(key, 'entry', 1), record(1));
    const generation = ['01', '+1', '1suffix', ' 1'].includes(raw) ? 1 : 0;

    expect(await store.readSnapshot(snapshotKey)).toEqual({ generationBefore: raw, value: record(generation), generationAfter: raw });
  });

  it.each([[], [null, null], ['0', 42, '0'], ['0', null, false]].map((reply) => ({ reply })))('rejects malformed Redis snapshot replies: $reply', async ({ reply }) => {
    const redis = new AtomicRedisFake();
    vi.spyOn(redis, 'eval').mockResolvedValue(reply);

    await expect(createRedisToolCacheStore(redis).readSnapshot(snapshotKey)).rejects.toThrow('invalid tool cache snapshot');
  });
});

describe('in-process snapshot fallback', () => {
  it('does not yield between generation and entry reads', async () => {
    const store = createInMemoryToolCacheStore();
    await store.write(snapshotKey.generationKey, '0', 1_000);
    await store.write(toolCacheKey(key, 'entry', 0), 'old', 1_000);
    const snapshot = store.readSnapshot(snapshotKey);
    await store.increment(snapshotKey.generationKey, 1_000);

    expect(await snapshot).toEqual({ generationBefore: '0', value: 'old', generationAfter: '0' });
  });

  it('honors entry TTL in a snapshot', async () => {
    let now = 0;
    const store = createInMemoryToolCacheStore({ now: () => now });
    await store.write(toolCacheKey(key, 'entry', 0), 'old', 1_000);
    now = 1_000;

    expect((await store.readSnapshot(snapshotKey)).value).toBeUndefined();
  });
});
