import type { RedisClientType } from 'redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Coordinator } from '../src/server/coordination.js';
import { AgentFacingError } from '../src/server/errors.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function leaseRequest(operation: () => Promise<void>, overrides: {
  provider?: string;
  userId?: string;
  maximumInFlight?: number;
} = {}) {
  return {
    provider: overrides.provider ?? 'github',
    userId: overrides.userId ?? 'user-a',
    maximumInFlight: overrides.maximumInFlight ?? 1,
    operation,
  };
}

function rateRequest(overrides: {
  provider?: string;
  userId?: string;
  maximumStarts?: number;
} = {}) {
  return {
    provider: overrides.provider ?? 'github',
    userId: overrides.userId ?? 'user-a',
    maximumStarts: overrides.maximumStarts ?? 1,
  };
}

describe('in-process rate limits', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('allows exactly the configured number of starts', async () => {
    const coordinator = new Coordinator();
    await expect(Promise.all([
      coordinator.enforceRateLimit(rateRequest({ maximumStarts: 2 })),
      coordinator.enforceRateLimit(rateRequest({ maximumStarts: 2 })),
    ])).resolves.toEqual([undefined, undefined]);
  });

  it('rejects a start over the configured limit', async () => {
    const coordinator = new Coordinator();
    await coordinator.enforceRateLimit(rateRequest());
    await expect(coordinator.enforceRateLimit(rateRequest())).rejects.toBeInstanceOf(AgentFacingError);
  });

  it('isolates each user quota for the same provider', async () => {
    const coordinator = new Coordinator();
    await coordinator.enforceRateLimit(rateRequest({ userId: 'user-a' }));
    await expect(coordinator.enforceRateLimit(rateRequest({ userId: 'user-b' }))).resolves.toBeUndefined();
  });

  it('isolates each provider quota for the same user', async () => {
    const coordinator = new Coordinator();
    await coordinator.enforceRateLimit(rateRequest({ provider: 'github' }));
    await expect(coordinator.enforceRateLimit(rateRequest({ provider: 'linear' }))).resolves.toBeUndefined();
  });

  it('resets at the exact 60-second window boundary', async () => {
    const coordinator = new Coordinator();
    await coordinator.enforceRateLimit(rateRequest());
    vi.setSystemTime(59_999);
    await expect(coordinator.enforceRateLimit(rateRequest())).rejects.toBeInstanceOf(AgentFacingError);
    vi.setSystemTime(60_000);
    await expect(coordinator.enforceRateLimit(rateRequest())).resolves.toBeUndefined();
  });
});

describe('in-process concurrency leases', () => {
  it('allows the exact limit and rejects the next call', async () => {
    const coordinator = new Coordinator();
    const gates = [deferred(), deferred()] as const;
    const first = coordinator.withConcurrencyLease(leaseRequest(() => gates[0].promise, { maximumInFlight: 2 }));
    const second = coordinator.withConcurrencyLease(leaseRequest(() => gates[1].promise, { maximumInFlight: 2 }));
    await expect(coordinator.withConcurrencyLease(leaseRequest(() => Promise.resolve(), { maximumInFlight: 2 })))
      .rejects.toBeInstanceOf(AgentFacingError);
    gates[0].resolve();
    gates[1].resolve();
    await Promise.all([first, second]);
  });

  it('does not release an accepted lease when a concurrent call is rejected', async () => {
    const coordinator = new Coordinator();
    const gate = deferred();
    const accepted = coordinator.withConcurrencyLease(leaseRequest(() => gate.promise));
    await expect(coordinator.withConcurrencyLease(leaseRequest(() => Promise.resolve())))
      .rejects.toBeInstanceOf(AgentFacingError);
    await expect(coordinator.withConcurrencyLease(leaseRequest(() => Promise.resolve())))
      .rejects.toBeInstanceOf(AgentFacingError);
    gate.resolve();
    await accepted;
    await expect(coordinator.withConcurrencyLease(leaseRequest(() => Promise.resolve()))).resolves.toBeUndefined();
  });

  it('isolates active leases by user and provider', async () => {
    const coordinator = new Coordinator();
    const gate = deferred();
    const active = coordinator.withConcurrencyLease(leaseRequest(() => gate.promise));
    await expect(Promise.all([
      coordinator.withConcurrencyLease(leaseRequest(() => Promise.resolve(), { userId: 'user-b' })),
      coordinator.withConcurrencyLease(leaseRequest(() => Promise.resolve(), { provider: 'linear' })),
    ])).resolves.toEqual([undefined, undefined]);
    gate.resolve();
    await active;
  });

  it('frees exactly one slot per completed lease, whatever order they finish in', async () => {
    const coordinator = new Coordinator();
    const gates = [deferred(), deferred(), deferred(), deferred()] as const;
    const first = coordinator.withConcurrencyLease(leaseRequest(() => gates[0].promise, { maximumInFlight: 2 }));
    const second = coordinator.withConcurrencyLease(leaseRequest(() => gates[1].promise, { maximumInFlight: 2 }));
    gates[1].resolve();
    await second;
    const third = coordinator.withConcurrencyLease(leaseRequest(() => gates[2].promise, { maximumInFlight: 2 }));
    gates[0].resolve();
    await first;
    const fourth = coordinator.withConcurrencyLease(leaseRequest(() => gates[3].promise, { maximumInFlight: 2 }));
    await expect(coordinator.withConcurrencyLease(leaseRequest(() => Promise.resolve(), { maximumInFlight: 2 })))
      .rejects.toBeInstanceOf(AgentFacingError);
    gates[2].resolve();
    gates[3].resolve();
    await Promise.all([third, fourth]);
  });

  it('releases the slot when the operation throws', async () => {
    const coordinator = new Coordinator();
    await expect(coordinator.withConcurrencyLease(leaseRequest(() => Promise.reject(new Error('boom')))))
      .rejects.toThrow('boom');
    await expect(coordinator.withConcurrencyLease(leaseRequest(() => Promise.resolve()))).resolves.toBeUndefined();
  });
});

describe('Redis concurrency leases', () => {
  it('acquires the count and TTL in one atomic script', async () => {
    const coordinator = new Coordinator();
    const evalCommand = vi.fn<(script: string, options: {
      keys: string[];
      arguments?: string[];
    }) => Promise<number>>().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    (coordinator as unknown as { redis: RedisClientType }).redis = { eval: evalCommand } as unknown as RedisClientType;

    await coordinator.withConcurrencyLease(leaseRequest(() => Promise.resolve()));

    const [script, options] = evalCommand.mock.calls[0]!;
    expect(script).toMatch(/redis\.call\('incr'.*redis\.call\('expire'/s);
    expect(options).toEqual({ keys: ['concurrency:github:user-a'], arguments: ['120'] });
  });

  it('releases only the rejected lease while another call remains active', async () => {
    const coordinator = new Coordinator();
    const counts = new Map<string, number>();
    const evalCommand = vi.fn<(script: string, options: {
      keys: string[];
      arguments?: string[];
    }) => Promise<number>>(async (script, { keys }) => {
      const key = keys[0]!;
      if (script.includes("redis.call('incr'")) {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return count;
      }
      const remaining = Math.max((counts.get(key) ?? 1) - 1, 0);
      if (remaining === 0) counts.delete(key);
      else counts.set(key, remaining);
      return remaining;
    });
    (coordinator as unknown as { redis: RedisClientType }).redis = { eval: evalCommand } as unknown as RedisClientType;
    const gate = deferred();
    const active = coordinator.withConcurrencyLease(leaseRequest(() => gate.promise));

    await expect(coordinator.withConcurrencyLease(leaseRequest(() => Promise.resolve())))
      .rejects.toBeInstanceOf(AgentFacingError);
    expect(counts.get('concurrency:github:user-a')).toBe(1);
    gate.resolve();
    await active;
    await expect(coordinator.withConcurrencyLease(leaseRequest(() => Promise.resolve()))).resolves.toBeUndefined();
  });
});

describe('in-process locks', () => {
  it('serializes operations for the same lock key', async () => {
    const coordinator = new Coordinator();
    const gate = deferred();
    const events: string[] = [];
    const first = coordinator.withLock('credential:user-a', async () => {
      events.push('first-start');
      await gate.promise;
      events.push('first-end');
    });
    const second = coordinator.withLock('credential:user-a', () => {
      events.push('second-start');
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(events).toEqual(['first-start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'first-end', 'second-start']);
  });
});

describe('in-process ephemeral values', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('hands a value back exactly once', async () => {
    const coordinator = new Coordinator();
    await coordinator.setEphemeral('k', 'v', 60);
    expect(await coordinator.takeEphemeral('k')).toBe('v');
    expect(await coordinator.takeEphemeral('k')).toBeUndefined();
  });

  it('treats an expired value as absent', async () => {
    const coordinator = new Coordinator();
    await coordinator.setEphemeral('k', 'v', 60);
    vi.advanceTimersByTime(60_001);
    expect(await coordinator.takeEphemeral('k')).toBeUndefined();
  });

  it('sweeps abandoned expired values instead of keeping them forever', async () => {
    const coordinator = new Coordinator();
    for (let index = 0; index < 100; index += 1) await coordinator.setEphemeral(`abandoned-${index}`, 'v', 60);
    vi.advanceTimersByTime(60_001);
    await coordinator.setEphemeral('fresh', 'v', 60);
    const store = (coordinator as unknown as { localEphemeral: Map<string, unknown> }).localEphemeral;
    expect(store.size).toBe(1);
  });
});
