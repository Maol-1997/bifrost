import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AgentFacingError } from './errors.js';
import type { RedisCommandsClient } from './redis.js';

const DEFAULT_LOCK_MS = 30_000;
const LOCK_POLL_MS = 50;
const RATE_WINDOW_SECONDS = 60;
const RATE_WINDOW_MS = RATE_WINDOW_SECONDS * 1_000;
const MAX_LOCAL_RATE_SCOPES = 10_000;
// This must outlive expected tool calls so a dead worker cannot make live work
// disappear from the shared count too early.
const CONCURRENCY_LEASE_SECONDS = 120;
const ACQUIRE_LEASE_SCRIPT = `
local count = redis.call('incr', KEYS[1])
redis.call('expire', KEYS[1], ARGV[1])
return count`;
const RATE_LIMIT_SCRIPT = `
local count = redis.call('incr', KEYS[1])
if count == 1 then redis.call('expire', KEYS[1], ARGV[1]) end
return count`;
// A late release after expiry must not recreate a negative counter and admit
// an extra call.
const RELEASE_LEASE_SCRIPT = `
local current = redis.call('get', KEYS[1])
if not current then return 0 end
local remaining = redis.call('decr', KEYS[1])
if remaining <= 0 then redis.call('del', KEYS[1]) end
return remaining`;
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

type RateLimitRequest = {
  provider: string;
  userId: string;
  maximumStarts: number;
};

type ConcurrencyLeaseRequest<T> = {
  provider: string;
  userId: string;
  maximumInFlight: number;
  operation: () => Promise<T>;
};

export class Coordinator {
  private readonly localLocks = new Map<string, Promise<void>>();
  private readonly localRates = new Map<string, { count: number; resetAt: number }>();
  private readonly localConcurrency = new Map<string, number>();
  private readonly localEphemeral = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly redis?: RedisCommandsClient) {}

  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.redis) return this.withRedisLock(key, operation, 0);
    return this.withLocalLock(key, operation);
  }

  /**
   * Like `withLock`, but a lock held by another worker is waited for, up to
   * `maxWaitMs`, instead of refused at once. For work whose result the waiter
   * can reuse, such as a token refresh another request already started; the
   * in-process lock already queues.
   */
  async withLockWaiting<T>(key: string, maxWaitMs: number, operation: () => Promise<T>): Promise<T> {
    if (this.redis) return this.withRedisLock(key, operation, maxWaitMs);
    return this.withLocalLock(key, operation);
  }

  async enforceRateLimit(request: RateLimitRequest): Promise<void> {
    if (!(await this.consumeRateLimit(tenantProviderScope(request), request.maximumStarts))) {
      throw rateLimitReached(request.provider);
    }
  }

  /**
   * Counts one start against `scope` in a fixed one-minute window shared by
   * every worker. False once the window already holds `maximum` starts.
   */
  async consumeRateLimit(scope: string, maximum: number): Promise<boolean> {
    const window = Math.floor(Date.now() / RATE_WINDOW_MS);
    if (this.redis) {
      const count = await this.redis.eval(RATE_LIMIT_SCRIPT, {
        keys: [`rate:${scope}:${window}`],
        arguments: [String(RATE_WINDOW_SECONDS)],
      });
      if (typeof count !== 'number') throw new Error('Redis returned an invalid rate limit count');
      return count <= maximum;
    }
    // Inbound scopes are keyed by client address, so the in-process fallback
    // must not keep one entry per address forever.
    if (this.localRates.size >= MAX_LOCAL_RATE_SCOPES) this.pruneLocalRates();
    const state = this.localRates.get(scope);
    const current =
      !state || state.resetAt <= Date.now() ? { count: 0, resetAt: (window + 1) * RATE_WINDOW_MS } : state;
    current.count += 1;
    this.localRates.set(scope, current);
    return current.count <= maximum;
  }

  private pruneLocalRates(): void {
    const now = Date.now();
    for (const [scope, state] of this.localRates) if (state.resetAt <= now) this.localRates.delete(scope);
  }

  async withConcurrencyLease<T>(request: ConcurrencyLeaseRequest<T>): Promise<T> {
    const scope = tenantProviderScope(request);
    const leaseKey = `concurrency:${scope}`;
    if (this.redis) {
      const redis = this.redis;
      const count = await redis.eval(ACQUIRE_LEASE_SCRIPT, {
        keys: [leaseKey],
        arguments: [String(CONCURRENCY_LEASE_SECONDS)],
      });
      if (typeof count !== 'number') throw new Error('Redis returned an invalid concurrency lease count');
      if (count > request.maximumInFlight) {
        await redis.eval(RELEASE_LEASE_SCRIPT, { keys: [leaseKey] });
        throw concurrencyLimitReached(request.provider);
      }
      try {
        return await request.operation();
      } finally {
        await redis.eval(RELEASE_LEASE_SCRIPT, { keys: [leaseKey] });
      }
    }
    const inFlight = this.localConcurrency.get(scope) ?? 0;
    if (inFlight >= request.maximumInFlight) throw concurrencyLimitReached(request.provider);
    this.localConcurrency.set(scope, inFlight + 1);
    try {
      return await request.operation();
    } finally {
      // Restoring the entry count would lose leases that started after it.
      const remaining = (this.localConcurrency.get(scope) ?? 1) - 1;
      if (remaining <= 0) this.localConcurrency.delete(scope);
      else this.localConcurrency.set(scope, remaining);
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

  async peekEphemeral(key: string): Promise<string | undefined> {
    if (this.redis) {
      const value = await this.redis.get(key);
      return value ?? undefined;
    }
    const entry = this.localEphemeral.get(key);
    return entry && entry.expiresAt > Date.now() ? entry.value : undefined;
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

  private async withRedisLock<T>(key: string, operation: () => Promise<T>, maxWaitMs: number): Promise<T> {
    const lockKey = key.startsWith('bifrost:v1:') ? key : `lock:${key}`;
    const owner = randomUUID();
    const deadline = Date.now() + maxWaitMs;
    while ((await this.redis?.set(lockKey, owner, { NX: true, PX: DEFAULT_LOCK_MS })) !== 'OK') {
      if (Date.now() >= deadline) throw new AgentFacingError('Credential refresh already in progress; retry shortly');
      await sleep(LOCK_POLL_MS);
    }
    try {
      return await operation();
    } finally {
      await this.redis?.eval(RELEASE_LOCK_SCRIPT, { keys: [lockKey], arguments: [owner] });
    }
  }

  private async withLocalLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.localLocks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
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

function tenantProviderScope(request: { provider: string; userId: string }): string {
  return `${request.provider}:${request.userId}`;
}

function rateLimitReached(provider: string): AgentFacingError {
  return new AgentFacingError(`${provider} outbound rate limit reached; retry later`);
}

function concurrencyLimitReached(provider: string): AgentFacingError {
  return new AgentFacingError(`${provider} concurrency limit reached; retry later`);
}
