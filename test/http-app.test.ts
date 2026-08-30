import { randomUUID } from 'node:crypto';
import type { McpHandlerRequestOptions } from '@modelcontextprotocol/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { Coordinator } from '../src/server/coordination.js';
import { createDatabase } from '../src/server/database/index.js';
import { createApp } from '../src/server/http/app.js';
import type { AppDependencies } from '../src/server/http/context.js';
import { BrowserEventBus } from '../src/server/http/events.js';
import { MAX_REQUEST_BODY_BYTES } from '../src/server/http/request-body.js';
import { createHumanMcpHandler } from '../src/server/mcp.js';
import { OAuthService } from '../src/server/oauth.js';
import type { ProviderMount } from '../src/server/providers/types.js';
import { createInMemoryToolCacheStore } from '../src/server/tools/cache-store.js';
import { ToolDiscoveryService } from '../src/server/tools/discovery.js';

const PUBLIC_HOST = 'bifrost.example.test';
const DEVELOPMENT_USER_ID = randomUUID();
const config = loadConfig({
  NODE_ENV: 'development',
  PUBLIC_URL: `https://${PUBLIC_HOST}`,
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BIFROST_DEV_USER_ID: DEVELOPMENT_USER_ID,
});
const database = createDatabase(config);
const coordinator = new Coordinator();
const oauth = new OAuthService(config, database, coordinator);
const mounts: readonly ProviderMount[] = [];
const toolDiscovery = new ToolDiscoveryService({ oauth, mounts, store: createInMemoryToolCacheStore() });
const mcpHandler = createHumanMcpHandler({ config, database, coordinator, oauth, mounts, toolDiscovery });
const dependencies: AppDependencies = {
  config,
  database,
  coordinator,
  oauth,
  mounts,
  mcpHandler,
  events: new BrowserEventBus(),
  toolDiscovery,
};
const app = createApp(dependencies);

afterAll(async () => {
  await mcpHandler.close();
  await database.close();
});

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Host', PUBLIC_HOST);
  return await app.request(`https://${PUBLIC_HOST}${path}`, { ...init, headers });
}

describe('HTTP security boundaries', () => {
  it('reports unavailable while configured Redis is not ready', async () => {
    const redisConfig = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_URL: `https://${PUBLIC_HOST}`,
      REDIS_URL: 'redis://redis:6379',
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    });
    const redisApp = createApp({ ...dependencies, config: redisConfig, redis: { isReady: false } });

    const response = await redisApp.request(`https://${PUBLIC_HOST}/healthz`, {
      headers: { Host: PUBLIC_HOST },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unavailable' });
  });

  it('allows the public hostname with any port', async () => {
    const response = await app.request(`https://${PUBLIC_HOST}:8443/healthz`, {
      headers: { Host: `${PUBLIC_HOST}:8443` },
    });
    expect(response.status).toBe(200);
  });

  it('allows localhost', async () => {
    const response = await app.request('http://localhost:5173/healthz', {
      headers: { Host: 'localhost:5173' },
    });
    expect(response.status).toBe(200);
  });

  it('allows IPv4 loopback', async () => {
    const response = await app.request('http://127.0.0.1:3000/healthz', {
      headers: { Host: '127.0.0.1:3000' },
    });
    expect(response.status).toBe(200);
  });

  it('rejects every other hostname', async () => {
    const response = await app.request('https://attacker.example/healthz', {
      headers: { Host: 'attacker.example' },
    });
    expect(response.status).toBe(403);
  });

  it('preserves the browser security headers', async () => {
    const response = await request('/healthz');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('allows only self-hosted font sources', async () => {
    const response = await request('/healthz');
    expect(response.headers.get('Content-Security-Policy')).toMatch(/font-src 'self' data:;/);
  });

  it('adds a request id when the caller does not provide one', async () => {
    const response = await request('/healthz');
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not accept a browser session cookie at the MCP endpoint', async () => {
    const response = await request('/mcp', {
      method: 'POST',
      headers: { Cookie: 'bifrost_session=session-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
  });

  it('does not accept a bearer token at browser API endpoints', async () => {
    const response = await request('/api/me.json', {
      headers: { Authorization: 'Bearer agent-token' },
    });
    expect(response.status).toBe(401);
  });
});

describe('request handling', () => {
  it('keeps the authorization route accessible without a browser session', async () => {
    const response = await request('/oauth/authorize');
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns 400 for invalid JSON', async () => {
    const response = await request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bifrost-Dev-User': DEVELOPMENT_USER_ID,
      },
      body: '{',
    });
    expect(response.status).toBe(400);
  });

  it('rejects invalid browser route parameters before the handler', async () => {
    const response = await request('/api/clients/browser/not-a-uuid/revoke', {
      method: 'POST',
      headers: { 'X-Bifrost-Dev-User': DEVELOPMENT_USER_ID },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found' });
  });

  it('rejects invalid browser JSON without exposing Zod details', async () => {
    const response = await request('/api/connections/github/preference', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bifrost-Dev-User': DEVELOPMENT_USER_ID,
      },
      body: JSON.stringify({ isHidden: 'yes' }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid request body' });
  });

  it('returns relative tool-cache freshness for frontend query scheduling', async () => {
    const spies = [
      vi.spyOn(database, 'listConnections').mockResolvedValue([]),
      vi.spyOn(database, 'hiddenProviders').mockResolvedValue(new Set()),
      vi.spyOn(database, 'toolPreferences').mockResolvedValue(new Map()),
      vi.spyOn(database, 'toolPolicies').mockResolvedValue(new Map()),
      vi.spyOn(database, 'connectedProviders').mockResolvedValue(new Set()),
    ];
    try {
      const response = await request('/api/app-connections.json', {
        headers: { 'X-Bifrost-Dev-User': DEVELOPMENT_USER_ID },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        cache: { state: 'fresh', freshForMs: 3_600_000, nextCheckInMs: 3_600_000 },
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('refreshes provider credentials before reading connection metadata', async () => {
    const callOrder: string[] = [];
    const spies = [
      vi.spyOn(database, 'connectedProviders').mockResolvedValue(new Set(['linear'])),
      vi.spyOn(oauth, 'refreshProviderConnectionIfNeeded').mockImplementation(async () => {
        callOrder.push('refresh');
        return 'connected';
      }),
      vi.spyOn(database, 'listConnections').mockImplementation(async () => {
        callOrder.push('list');
        return [{
          providerId: 'linear',
          connectedAt: new Date('2026-08-30T00:00:00.000Z'),
          accountLabel: undefined,
          scopes: ['read', 'write'],
        }];
      }),
      vi.spyOn(database, 'hiddenProviders').mockResolvedValue(new Set()),
      vi.spyOn(database, 'toolPreferences').mockResolvedValue(new Map()),
      vi.spyOn(database, 'toolPolicies').mockResolvedValue(new Map()),
      vi.spyOn(toolDiscovery, 'discoverConnected').mockResolvedValue({
        tools: [],
        failures: [],
        cache: { state: 'fresh', freshForMs: 3_600_000, nextCheckInMs: 3_600_000 },
      }),
    ];
    try {
      const response = await request('/api/app-connections.json', {
        headers: { 'X-Bifrost-Dev-User': DEVELOPMENT_USER_ID },
      });
      const payload = await response.json() as { apps: { providerId: string; needsReconnect: boolean }[] };

      expect({
        callOrder,
        linear: payload.apps.find((provider) => provider.providerId === 'linear'),
        status: response.status,
      }).toMatchObject({
        callOrder: ['refresh', 'list'],
        linear: { providerId: 'linear', needsReconnect: false },
        status: 200,
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('passes the web-standard request, parsed body, and agent identity directly to the MCP handler', async () => {
    let captured: { request: Request; options?: McpHandlerRequestOptions } | undefined;
    const testMcpHandler: AppDependencies['mcpHandler'] = {
      ...mcpHandler,
      fetch: async (rawRequest, options) => {
        captured = { request: rawRequest, ...(options ? { options } : {}) };
        return Response.json({ ok: true });
      },
    };
    const testApp = createApp({ ...dependencies, mcpHandler: testMcpHandler });
    const response = await testApp.request(`https://${PUBLIC_HOST}/mcp`, {
      method: 'POST',
      headers: {
        Host: PUBLIC_HOST,
        'Content-Type': 'application/json',
        'X-Bifrost-Dev-User': DEVELOPMENT_USER_ID,
        'X-Request-Id': 'request-123',
      },
      body: JSON.stringify({ method: 'tools/list', params: {} }),
    });

    if (!captured) throw new Error('MCP handler was not called');
    expect(captured.request).toBeInstanceOf(Request);
    expect(captured.options?.authInfo?.extra).toEqual({ userId: DEVELOPMENT_USER_ID });
    expect(captured.options?.parsedBody).toMatchObject({
      params: { _meta: { requestId: 'request-123' } },
    });
    expect(response.headers.get('X-Request-Id')).toBe('request-123');
  });

  it('marks OAuth JSON errors as non-cacheable', async () => {
    const response = await request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects a request body larger than 1,048,576 bytes', async () => {
    const response = await request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
  });
});
