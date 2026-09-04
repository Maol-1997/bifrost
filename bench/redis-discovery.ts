import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import type { Config } from '../src/server/config.js';
import type { Coordinator } from '../src/server/coordination.js';
import type { Database } from '../src/server/database/index.js';
import type { OAuthService } from '../src/server/oauth.js';
import { PROVIDER_REGISTRY } from '../src/server/providers/registry.js';
import { normalizeUpstreamTool } from '../src/server/tools/catalog.js';
import { createRedisToolCacheStore, parseToolCacheGeneration, type ToolCacheRedisCommands, type ToolCacheStore } from '../src/server/tools/cache-store.js';
import { toolCacheKey, ToolDiscoveryCache } from '../src/server/tools/discovery-cache.js';
import { ToolDiscoveryService } from '../src/server/tools/discovery.js';
import { loadVisibleUserTools, type UserToolDependencies } from '../src/server/tools/user-toolset.js';

const SAMPLES = 9;
const ITERATIONS = 200;
const userId = randomUUID();
const url = process.env.REDIS_URL;
assert.ok(url, 'Set REDIS_URL to the isolated benchmark Redis');
const redis = createClient({ url });
redis.on('error', (error: Error) => { throw error; });
await redis.connect();
const commandsByProvider = new Map<string, number>();
const commands: ToolCacheRedisCommands = {
  async eval(script, options) {
    const provider = options.keys[0]?.split(':')[4] ?? 'unknown';
    commandsByProvider.set(provider, (commandsByProvider.get(provider) ?? 0) + 1);
    return redis.eval(script, options);
  },
  set: (key, value, options) => redis.set(key, value, options),
};
const atomicStore = createRedisToolCacheStore(commands);
// The exact generation -> entry -> generation sequence from 94c3a08.
const serialStore: ToolCacheStore = {
  ...atomicStore,
  async readSnapshot(key) {
    const generationBefore = await atomicStore.read(key.generationKey);
    const generation = parseToolCacheGeneration(generationBefore);
    const value = await atomicStore.read(`${key.entryKeyPrefix}${generation}`);
    return { generationBefore, value, generationAfter: await atomicStore.read(key.generationKey) };
  },
};
const tools = PROVIDER_REGISTRY.flatMap((provider) => Array.from({ length: 50 }, (_, index) => normalizeUpstreamTool(provider, {
  name: `search_records_${index}`,
  description: `Search ${provider.displayName} records with pagination and filters. Tool ${index}.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search expression' },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      filters: { type: 'object', properties: { state: { type: 'string', enum: ['open', 'closed'] }, labels: { type: 'array', items: { type: 'string' } } } },
    },
    required: ['query'],
  },
  outputSchema: { type: 'object', properties: { records: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } }, nextPage: { type: 'integer' } } },
  annotations: { readOnlyHint: true },
})));
const keys = PROVIDER_REGISTRY.map((provider) => ({ userId, providerId: provider.id }));
const cleanupKeys = keys.flatMap((key, generation) => [toolCacheKey(key, 'generation'), toolCacheKey(key, 'entry', generation), toolCacheKey(key, 'refresh', generation)]);
const seed = new ToolDiscoveryCache({ store: atomicStore });
const policies = new Map(tools.map((tool) => [tool.name, { toolName: tool.name, fingerprint: tool.fingerprint, state: 'allowed_default_on' as const }]));
const mounts = PROVIDER_REGISTRY.map((provider) => ({ providerId: provider.id, isMounted: true }));
const oauth = {} as OAuthService;
function dependencies(store: ToolCacheStore): UserToolDependencies {
  return {
    config: {} as Config,
    coordinator: {} as Coordinator,
    oauth,
    mounts,
    database: {
      connectedProviders: async () => new Set(PROVIDER_REGISTRY.map((provider) => provider.id)),
      hiddenProviders: async () => new Set(),
      toolPreferences: async () => new Map(),
      toolPolicyDecisions: async () => policies,
    } as unknown as Database,
    toolDiscovery: new ToolDiscoveryService({ oauth, mounts, store }),
  };
}
const variants = [
  { label: 'before: serial reads', dependencies: dependencies(serialStore), expectedCommands: 18, expectedWaves: 3, samples: [] as number[] },
  { label: 'after: Lua snapshot', dependencies: dependencies(atomicStore), expectedCommands: 6, expectedWaves: 1, samples: [] as number[] },
];
try {
  for (const [generation, key] of keys.entries()) {
    // Include absent generation zero and nonzero generations in the real Lua check.
    if (generation > 0) await atomicStore.write(toolCacheKey(key, 'generation'), String(generation), 60_000);
    await seed.readFresh(key, async () => tools.filter((tool) => tool.providerId === key.providerId));
  }
  for (const variant of variants) {
    for (let iteration = 0; iteration < 50; iteration += 1) {
      assert.equal((await loadVisibleUserTools({ userId, dependencies: variant.dependencies })).length, 300);
    }
    commandsByProvider.clear();
    await loadVisibleUserTools({ userId, dependencies: variant.dependencies });
    assert.equal([...commandsByProvider.values()].reduce((sum, count) => sum + count, 0), variant.expectedCommands);
    assert.equal(Math.max(...commandsByProvider.values()), variant.expectedWaves);
  }
  // Alternate order to reduce shared-host and warmup bias.
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    for (const variant of sample % 2 ? [...variants].reverse() : variants) {
      const started = performance.now();
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        await loadVisibleUserTools({ userId, dependencies: variant.dependencies });
      }
      variant.samples.push((performance.now() - started) / ITERATIONS);
    }
  }
  for (const variant of variants) {
    variant.samples.sort((left, right) => left - right);
    console.log(JSON.stringify({ label: variant.label, tools: tools.length, commandsPerRequest: variant.expectedCommands, dependencyWaves: variant.expectedWaves, medianMs: variant.samples[Math.floor(SAMPLES / 2)], samplesMs: variant.samples }));
  }
} finally {
  await redis.del(cleanupKeys);
  await redis.close();
}
