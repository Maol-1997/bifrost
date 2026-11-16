import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/server/config.js';
import { Coordinator } from '../src/server/coordination.js';
import type { AppDependencies, AppEnv } from '../src/server/http/context.js';
import { INBOUND_RATE_LIMITS, rateLimitByAddress, rateLimitByUser } from '../src/server/http/rate-limit.js';
import type { BrowserIdentity } from '../src/server/mcp.js';

function testApp(trustedProxyHops = 0) {
  const dependencies = {
    config: { TRUSTED_PROXY_HOPS: trustedProxyHops } as Config,
    coordinator: new Coordinator(),
  } as AppDependencies;
  const app = new Hono<AppEnv>();
  app.use('*', async (context, next) => {
    context.set('dependencies', dependencies);
    context.set('browserIdentity', { userId: context.req.header('x-test-user') ?? 'user-1' } as BrowserIdentity);
    await next();
  });
  app.post('/oauth/token', rateLimitByAddress('tokenExchange', 'oauth'), (context) => context.json({ ok: true }));
  app.post('/api/chat', rateLimitByUser('chatTurn'), (context) => context.json({ ok: true }));
  return app;
}

async function exhaust(app: Hono<AppEnv>, path: string, count: number, headers: Record<string, string> = {}) {
  for (let index = 0; index < count; index += 1) {
    const response = await app.request(path, { method: 'POST', headers });
    expect(response.status).toBe(200);
  }
}

describe('inbound rate limits', () => {
  it('answers 429 with Retry-After and an OAuth error once the window is full', async () => {
    const app = testApp();
    await exhaust(app, '/oauth/token', INBOUND_RATE_LIMITS.tokenExchange);

    const limited = await app.request('/oauth/token', { method: 'POST' });

    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
  });

  it('ignores X-Forwarded-For unless a proxy is trusted, so a caller cannot pick a fresh bucket', async () => {
    const app = testApp(0);
    await exhaust(app, '/oauth/token', INBOUND_RATE_LIMITS.tokenExchange, { 'x-forwarded-for': '203.0.113.1' });

    const spoofed = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.2' },
    });

    expect(spoofed.status).toBe(429);
  });

  it('keeps separate buckets per address behind a trusted proxy, using the address the proxy appended', async () => {
    const app = testApp(1);
    await exhaust(app, '/oauth/token', INBOUND_RATE_LIMITS.tokenExchange, {
      'x-forwarded-for': 'spoofed, 203.0.113.1',
    });

    const sameClient = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'x-forwarded-for': 'other-spoof, 203.0.113.1' },
    });
    const otherClient = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.2' },
    });

    expect([sameClient.status, otherClient.status]).toEqual([429, 200]);
  });

  it('limits chat turns per signed-in user', async () => {
    const app = testApp();
    await exhaust(app, '/api/chat', INBOUND_RATE_LIMITS.chatTurn, { 'x-test-user': 'user-1' });

    const sameUser = await app.request('/api/chat', { method: 'POST', headers: { 'x-test-user': 'user-1' } });
    const otherUser = await app.request('/api/chat', { method: 'POST', headers: { 'x-test-user': 'user-2' } });

    expect([sameUser.status, otherUser.status]).toEqual([429, 200]);
    expect(await sameUser.json()).toEqual({ error: 'Too many requests. Try again in a minute.' });
  });
});
