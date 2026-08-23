/**
 * The whole storage surface the shared tool cache needs. Redis in a deployment,
 * an in-process map in tests and single-worker development. Keeping it this
 * narrow is what lets the cache itself stay pure logic: it never learns which
 * backend it holds, and neither backend knows what a tool is.
 */
export type ToolCacheStore = {
  read(key: string): Promise<string | undefined>;
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
  return {
    async read(key) {
      const value = await commands.eval(READ_SCRIPT, { keys: [key] });
      return typeof value === 'string' ? value : undefined;
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
