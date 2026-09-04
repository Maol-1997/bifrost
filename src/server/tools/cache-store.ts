export type ToolCacheSnapshotKey = {
  generationKey: string;
  entryKeyPrefix: string;
};

export type ToolCacheSnapshot = {
  generationBefore: string | undefined;
  value: string | undefined;
  generationAfter: string | undefined;
};

/**
 * The whole storage surface the shared tool cache needs. Redis in a deployment,
 * an in-process map in tests and single-worker development. Keeping it this
 * narrow is what lets the cache itself stay pure logic: it never learns which
 * backend it holds, and neither backend knows what a tool is.
 */
export type ToolCacheStore = {
  read(key: string): Promise<string | undefined>;
  /** Observes generation on both sides of its entry; canonical reads are atomic. */
  readSnapshot(key: ToolCacheSnapshotKey): Promise<ToolCacheSnapshot>;
  write(key: string, value: string, ttlMs: number): Promise<void>;
  /** Resolves false when the key already exists; this is the refresh lock. */
  writeIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** Releases a lock only when this caller still owns it. */
  removeIfEqual(key: string, value: string): Promise<void>;
  increment(key: string, ttlMs: number): Promise<number>;
};

/**
 * The two Redis commands the store adapter needs. Declared structurally so the
 * cache does not depend on the shared Redis runtime module, and so a deployment
 * can hand it any client with this shape.
 */
export type ToolCacheRedisCommands = {
  eval(script: string, options: { keys: string[]; arguments?: string[] }): Promise<unknown>;
  set(key: string, value: string, options?: { NX?: true; PX?: number }): Promise<string | null>;
};

const DEFAULT_MAX_ENTRIES = 4_096;
const READ_SCRIPT = "return redis.call('get', KEYS[1])";
// The entry key depends on the generation just read. This targets the existing
// standalone Redis runtime, not Redis Cluster (which needs fixed, same-slot keys).
// Both generation observations share one Redis execution: no invalidation or
// refresh can interleave between them and the entry read.
const READ_SNAPSHOT_SCRIPT = `
local before = redis.call('get', KEYS[1])
local entry = redis.call('get', ARGV[1] .. (before or '0'))
local after = redis.call('get', KEYS[1])
return {before, entry, after}`;
const REMOVE_SCRIPT = "return redis.call('del', KEYS[1])";
// A lock must only be released by the worker that took it; a plain del would
// let a slow worker drop the lock a later refresh is relying on.
const REMOVE_IF_EQUAL_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;
// The expiry is refreshed on every bump so an actively invalidated key keeps
// its generation for as long as any entry could still be referring to it.
const INCREMENT_SCRIPT = `
local value = redis.call('incr', KEYS[1])
redis.call('pexpire', KEYS[1], ARGV[1])
return value`;

export function createRedisToolCacheStore(commands: ToolCacheRedisCommands): ToolCacheStore {
  const read = async (key: string): Promise<string | undefined> => {
    const value = await commands.eval(READ_SCRIPT, { keys: [key] });
    return typeof value === 'string' ? value : undefined;
  };
  return {
    read,

    async readSnapshot(key) {
      const result = await commands.eval(READ_SNAPSHOT_SCRIPT, {
        keys: [key.generationKey],
        arguments: [key.entryKeyPrefix],
      });
      if (!Array.isArray(result) || result.length !== 3) throw new Error('Redis returned an invalid tool cache snapshot');
      const generationBefore = snapshotString(result[0]);
      const generation = parseToolCacheGeneration(generationBefore);
      // INCR writes canonical decimal integers. Preserve the old normalization
      // for noncanonical/corrupt generations without selecting the wrong key.
      if ((generationBefore ?? '0') !== String(generation)) {
        return {
          generationBefore,
          value: await read(`${key.entryKeyPrefix}${generation}`),
          generationAfter: await read(key.generationKey),
        };
      }
      return { generationBefore, value: snapshotString(result[1]), generationAfter: snapshotString(result[2]) };
    },

    async write(key, value, ttlMs) {
      await commands.set(key, value, { PX: ttlMs });
    },

    async writeIfAbsent(key, value, ttlMs) {
      return await commands.set(key, value, { NX: true, PX: ttlMs }) === 'OK';
    },

    async remove(key) {
      await commands.eval(REMOVE_SCRIPT, { keys: [key] });
    },

    async removeIfEqual(key, value) {
      await commands.eval(REMOVE_IF_EQUAL_SCRIPT, { keys: [key], arguments: [value] });
    },

    async increment(key, ttlMs) {
      const value = await commands.eval(INCREMENT_SCRIPT, { keys: [key], arguments: [String(ttlMs)] });
      if (typeof value !== 'number') throw new Error('Redis returned an invalid tool cache generation');
      return value;
    },
  };
}

type MemoryEntry = {
  value: string;
  expiresAt: number;
};

export type InMemoryToolCacheOptions = {
  now?: () => number;
  maxEntries?: number;
};

/**
 * The single-worker backend. Expiry is lazy, so an entry nothing ever reads
 * again would otherwise live until restart; the entry bound is what keeps a
 * churning key space from growing without limit.
 */
export function createInMemoryToolCacheStore(options: InMemoryToolCacheOptions = {}): ToolCacheStore {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, MemoryEntry>();

  const live = (key: string): MemoryEntry | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  const store = (key: string, value: string, ttlMs: number): void => {
    entries.delete(key);
    entries.set(key, { value, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) return;
      entries.delete(oldestKey);
    }
  };

  return {
    async read(key) {
      return live(key)?.value;
    },

    async readSnapshot(key) {
      // No await: JavaScript writers cannot run between these observations.
      const generationBefore = live(key.generationKey)?.value;
      const value = live(`${key.entryKeyPrefix}${parseToolCacheGeneration(generationBefore)}`)?.value;
      return { generationBefore, value, generationAfter: live(key.generationKey)?.value };
    },

    async write(key, value, ttlMs) {
      store(key, value, ttlMs);
    },

    async writeIfAbsent(key, value, ttlMs) {
      if (live(key)) return false;
      store(key, value, ttlMs);
      return true;
    },

    async remove(key) {
      entries.delete(key);
    },

    async removeIfEqual(key, value) {
      if (live(key)?.value === value) entries.delete(key);
    },

    async increment(key, ttlMs) {
      const current = Number.parseInt(live(key)?.value ?? '0', 10);
      const next = Number.isSafeInteger(current) ? current + 1 : 1;
      store(key, String(next), ttlMs);
      return next;
    },
  };
}

function snapshotString(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (typeof value === 'string') return value;
  throw new Error('Redis returned an invalid tool cache snapshot field');
}

export function parseToolCacheGeneration(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const generation = Number.parseInt(raw, 10);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}
