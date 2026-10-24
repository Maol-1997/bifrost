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

describe('encryption keyring configuration', () => {
  const OTHER_KEY = Buffer.alloc(32, 2).toString('base64');
  const keyIds = (environment: NodeJS.ProcessEnv): { active: string; keys: string[] } => {
    const { encryptionKeyring } = loadConfig({ NODE_ENV: 'test', ...environment });
    return { active: encryptionKeyring.activeKeyId, keys: [...encryptionKeyring.keys.keys()].sort() };
  };

  it('treats a lone ENCRYPTION_KEY as the active legacy key', () => {
    expect(keyIds({ ENCRYPTION_KEY })).toEqual({ active: 'legacy', keys: ['legacy'] });
  });

  it('adds ENCRYPTION_KEY to a keyring as the legacy key that version 1 records need', () => {
    expect(keyIds({ ENCRYPTION_KEY, ENCRYPTION_KEYS: JSON.stringify({ k2: OTHER_KEY }), ENCRYPTION_ACTIVE_KEY_ID: 'k2' }))
      .toEqual({ active: 'k2', keys: ['k2', 'legacy'] });
  });

  it('accepts a keyring without ENCRYPTION_KEY once nothing needs the legacy key', () => {
    expect(keyIds({ ENCRYPTION_KEYS: JSON.stringify({ k2: OTHER_KEY }), ENCRYPTION_ACTIVE_KEY_ID: 'k2' }))
      .toEqual({ active: 'k2', keys: ['k2'] });
  });

  it('requires some key', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow('ENCRYPTION_KEY is required');
  });

  it('requires the active key to be named when a keyring is set', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEYS: JSON.stringify({ k2: OTHER_KEY }) }))
      .toThrow('ENCRYPTION_ACTIVE_KEY_ID is required when ENCRYPTION_KEYS is set');
  });

  it('refuses an active key id that is not configured', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY, ENCRYPTION_ACTIVE_KEY_ID: 'k2' }))
      .toThrow('ENCRYPTION_ACTIVE_KEY_ID "k2" is not a configured key');
  });

  it('refuses any key that does not decode to 32 bytes, active or not', () => {
    const short = Buffer.alloc(16, 3).toString('base64');

    expect(() => loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY: short })).toThrow('ENCRYPTION_KEY must decode to exactly 32 bytes');
    expect(() => loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEYS: JSON.stringify({ k2: OTHER_KEY, old: short }), ENCRYPTION_ACTIVE_KEY_ID: 'k2' }))
      .toThrow('Encryption key "old" must decode to exactly 32 bytes');
  });

  it('refuses malformed keyrings and key ids', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEYS: 'not json', ENCRYPTION_ACTIVE_KEY_ID: 'k2' }))
      .toThrow('ENCRYPTION_KEYS must be a JSON object');
    expect(() => loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEYS: JSON.stringify({ 'bad id': OTHER_KEY }), ENCRYPTION_ACTIVE_KEY_ID: 'bad id' }))
      .toThrow('ENCRYPTION_KEYS must map ids');
  });

  it('refuses two different values for the legacy key', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY, ENCRYPTION_KEYS: JSON.stringify({ legacy: OTHER_KEY }), ENCRYPTION_ACTIVE_KEY_ID: 'legacy' }))
      .toThrow('ENCRYPTION_KEY and ENCRYPTION_KEYS.legacy are different keys');
  });
});

describe('pool sizing configuration', () => {
  it('defaults to 20 Postgres connections and 200 upstream clients idle for five minutes', () => {
    const config = loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY });

    expect([config.DATABASE_POOL_MAX, config.UPSTREAM_CLIENT_MAX, config.UPSTREAM_CLIENT_IDLE_SECONDS]).toEqual([20, 200, 300]);
  });

  it('accepts overrides and refuses a pool that cannot hold a connection', () => {
    expect(loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY, DATABASE_POOL_MAX: '50' }).DATABASE_POOL_MAX).toBe(50);
    expect(() => loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY, DATABASE_POOL_MAX: '0' })).toThrow('DATABASE_POOL_MAX');
  });
});
