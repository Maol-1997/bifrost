import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import { errorSummary, logger } from './logger.js';

const DEFAULT_LOCK_MS = 30_000;
const RATE_WINDOW_SECONDS = 60;

export class Coordinator {
  private redis: RedisClientType | undefined;
  private readonly localLocks = new Map<string, Promise<void>>();
  private readonly localRates = new Map<string, { count: number; resetAt: number }>();
  private readonly localConcurrency = new Map<string, number>();

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
      if (count > maximumStarts) throw new Error(`${provider} outbound rate limit reached; retry later`);
      return;
    }
    const now = Date.now();
    const state = this.localRates.get(provider);
    const current = !state || state.resetAt <= now ? { count: 0, resetAt: now + RATE_WINDOW_SECONDS * 1000 } : state;
    current.count += 1;
    this.localRates.set(provider, current);
    if (current.count > maximumStarts) throw new Error(`${provider} outbound rate limit reached; retry later`);
  }

  async withConcurrencyLease<T>(provider: string, maximumInFlight: number, operation: () => Promise<T>): Promise<T> {
    const leaseKey = `concurrency:${provider}`;
    if (this.redis) {
      const count = await this.redis.incr(leaseKey);
      await this.redis.expire(leaseKey, RATE_WINDOW_SECONDS);
      if (count > maximumInFlight) {
        await this.redis.decr(leaseKey);
        throw new Error(`${provider} concurrency limit reached; retry later`);
      }
      try {
        return await operation();
      } finally {
        await this.redis.decr(leaseKey);
      }
    }
    const current = this.localConcurrency.get(provider) ?? 0;
    if (current >= maximumInFlight) throw new Error(`${provider} concurrency limit reached; retry later`);
    this.localConcurrency.set(provider, current + 1);
    try {
      return await operation();
    } finally {
      this.localConcurrency.set(provider, current);
    }
  }

  async setEphemeral(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redis) {
      await this.redis.set(key, value, { EX: ttlSeconds });
      return;
    }
    this.localEphemeral.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
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

  private readonly localEphemeral = new Map<string, { value: string; expiresAt: number }>();

  private async withRedisLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const lockKey = `lock:${key}`;
    const owner = randomUUID();
    const acquired = await this.redis?.set(lockKey, owner, { NX: true, PX: DEFAULT_LOCK_MS });
    if (acquired !== 'OK') throw new Error('Credential refresh already in progress; retry shortly');
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
