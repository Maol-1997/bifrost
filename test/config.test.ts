import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';

const ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');

describe('Redis production configuration', () => {
  it('requires REDIS_URL in production', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      PUBLIC_URL: 'https://bifrost.example',
      ENCRYPTION_KEY,
    })).toThrow('REDIS_URL is required in production');
  });

  it('accepts production when Redis is configured', () => {
    expect(loadConfig({
      NODE_ENV: 'production',
      PUBLIC_URL: 'https://bifrost.example',
      REDIS_URL: 'redis://redis:6379',
      ENCRYPTION_KEY,
    }).REDIS_URL).toBe('redis://redis:6379');
  });

  it('keeps Redis optional outside production', () => {
    expect(loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY }).REDIS_URL).toBeUndefined();
  });
});
