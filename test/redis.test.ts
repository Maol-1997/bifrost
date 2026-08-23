import { describe, expect, it } from 'vitest';
import { failFastBeforeFirstReady, redisClientOptions } from '../src/server/redis.js';

describe('Redis reconnect policy', () => {
  it('fails commands instead of queueing them while Redis is disconnected', () => {
    const options = redisClientOptions('redis://redis:6379', failFastBeforeFirstReady());

    expect(options.disableOfflineQueue).toBe(true);
  });

  it('returns the initial connection error instead of retrying startup forever', () => {
    const reconnect = failFastBeforeFirstReady();
    const failure = new Error('connection refused');

    expect(reconnect.strategy(0, failure)).toBe(failure);
  });

  it('reconnects with bounded backoff after Redis was ready once', () => {
    const reconnect = failFastBeforeFirstReady();
    reconnect.markReady();

    expect(reconnect.strategy(0, new Error('connection lost'))).toBe(50);
    expect(reconnect.strategy(20, new Error('still down'))).toBe(3_000);
  });
});
