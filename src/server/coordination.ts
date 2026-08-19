import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import { AgentFacingError } from './errors.js';
import { errorSummary, logger } from './logger.js';

const DEFAULT_LOCK_MS = 30_000;
const RATE_WINDOW_SECONDS = 60;
/**
 * Upper bound on how long a lease outlives its holder if the process dies
 * mid-call. Deliberately longer than any tool call should take, because an
 * expired counter under-counts live work.
 */
const CONCURRENCY_LEASE_SECONDS = 120;
/**
 * Only decrements a counter that still exists and deletes it at zero, so a
 * lease released after its key expired does not recreate it at -1 and hand out
 * one extra slot forever after.
 */
const RELEASE_LEASE_SCRIPT = `
local current = redis.call('get', KEYS[1])
if not current then return 0 end
local remaining = redis.call('decr', KEYS[1])
if remaining <= 0 then redis.call('del', KEYS[1]) end
return remaining`;

export class Coordinator {
  private redis: RedisClientType | undefined;
  private readonly localLocks = new Map<string, Promise<void>>();
  private readonly localRates = new Map<string, { count: number; resetAt: number }>();
  private readonly localConcurrency = new Map<string, number>();
  private readonly localEphemeral = new Map<string, { value: string; expiresAt: number }>();

  async connect(redisUrl?: string): Promise<void> {
    if (!redisUrl) {
      logger.warn({ mode: 'in-process' }, 'Redis is unconfigured; locks, rate limits, and concurrency leases are not shared across workers');
      return;
    }
    try {
      this.redis = createClient({ url: redisUrl });
      this.redis.on('error', (error) => logger.error(errorSummary(error), 'Redis error'));
      await this.redis.connect();
    } catch (error) {
      this.redis = undefined;
      logger.warn(errorSummary(error), 'Redis unavailable; degraded to in-process coordination');
    }
  }

  async close(): Promise<void> {
    if (this.redis?.isOpen) await this.redis.quit();
  }

  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.redis) return this.withRedisLock(key, operation);
    return this.withLocalLock(key, operation);
  }

  async enforceRateLimit(provider: string, maximumStarts: number): Promise<void> {
    const key = `rate:${provider}:${Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000))}`;
    if (this.redis) {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, RATE_WINDOW_SECONDS);
      if (count > maximumStarts) throw rateLimitReached(provider);
      return;
    }
    const now = Date.now();
    const state = this.localRates.get(provider);
    const current = !state || state.resetAt <= now ? { count: 0, resetAt: now + RATE_WINDOW_SECONDS * 1000 } : state;
    current.count += 1;
    this.localRates.set(provider, current);
    if (current.count > maximumStarts) throw rateLimitReached(provider);
  }

  async withConcurrencyLease<T>(provider: string, maximumInFlight: number, operation: () => Promise<T>): Promise<T> {
    const leaseKey = `concurrency:${provider}`;
    if (this.redis) {
      const redis = this.redis;
      const count = await redis.incr(leaseKey);
      await redis.expire(leaseKey, CONCURRENCY_LEASE_SECONDS);
      if (count > maximumInFlight) {
        await redis.eval(RELEASE_LEASE_SCRIPT, { keys: [leaseKey] });
        throw concurrencyLimitReached(provider);
      }
      try {
        return await operation();
      } finally {
        await redis.eval(RELEASE_LEASE_SCRIPT, { keys: [leaseKey] });
      }
    }
    const inFlight = this.localConcurrency.get(provider) ?? 0;
    if (inFlight >= maximumInFlight) throw concurrencyLimitReached(provider);
    this.localConcurrency.set(provider, inFlight + 1);
    try {
      return await operation();
    } finally {
      // Decrement the live count rather than restore the one captured at entry:
      // leases finish in any order, and restoring would resurrect slots that
      // a later starter had already taken.
      const remaining = (this.localConcurrency.get(provider) ?? 1) - 1;
      if (remaining <= 0) this.localConcurrency.delete(provider);
      else this.localConcurrency.set(provider, remaining);
    }
  }

  async setEphemeral(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redis) {
      await this.redis.set(key, value, { EX: ttlSeconds });
      return;
    }
    // Abandoned values (an OAuth start nobody finishes) are only ever read by
    // their own key, so without this sweep they would accumulate until restart.
    const now = Date.now();
    for (const [existingKey, entry] of this.localEphemeral) {
      if (entry.expiresAt <= now) this.localEphemeral.delete(existingKey);
    }
    this.localEphemeral.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
  }

  async takeEphemeral(key: string): Promise<string | undefined> {
    if (this.redis) {
      const value = await this.redis.getDel(key);
      return value ?? undefined;
    }
    const entry = this.localEphemeral.get(key);
    this.localEphemeral.delete(key);
    return entry && entry.expiresAt > Date.now() ? entry.value : undefined;
  }

  private async withRedisLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const lockKey = `lock:${key}`;
    const owner = randomUUID();
    const acquired = await this.redis?.set(lockKey, owner, { NX: true, PX: DEFAULT_LOCK_MS });
    if (acquired !== 'OK') throw new AgentFacingError('Credential refresh already in progress; retry shortly');
    try {
      return await operation();
    } finally {
      const releaseScript = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
      await this.redis?.eval(releaseScript, { keys: [lockKey], arguments: [owner] });
    }
  }

  private async withLocalLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.localLocks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = predecessor.then(() => current);
    this.localLocks.set(key, queued);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.localLocks.get(key) === queued) this.localLocks.delete(key);
    }
  }
}

function rateLimitReached(provider: string): AgentFacingError {
  return new AgentFacingError(`${provider} outbound rate limit reached; retry later`);
}

function concurrencyLimitReached(provider: string): AgentFacingError {
  return new AgentFacingError(`${provider} concurrency limit reached; retry later`);
}
