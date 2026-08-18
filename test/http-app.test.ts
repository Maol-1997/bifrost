import { randomUUID } from 'node:crypto';
import type { McpHandlerRequestOptions } from '@modelcontextprotocol/server';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Coordinator } from '../src/coordination.js';
import { Database } from '../src/db.js';
import { createApp } from '../src/http/app.js';
import type { AppDependencies } from '../src/http/context.js';
import { MAX_REQUEST_BODY_BYTES } from '../src/http/request-body.js';
import { createHumanMcpHandler } from '../src/mcp.js';
import { OAuthService } from '../src/oauth.js';
import type { ProviderMount } from '../src/providers/types.js';

const PUBLIC_HOST = 'bifrost.example.test';
const DEVELOPMENT_USER_ID = randomUUID();
const config = loadConfig({
  NODE_ENV: 'development',
  PUBLIC_URL: `https://${PUBLIC_HOST}`,
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BIFROST_DEV_USER_ID: DEVELOPMENT_USER_ID,
});
const database = new Database(config);
const coordinator = new Coordinator();
const oauth = new OAuthService(config, database, coordinator);
const mounts: readonly ProviderMount[] = [];
const mcpHandler = createHumanMcpHandler({ config, database, coordinator, oauth, mounts });
const dependencies: AppDependencies = { config, database, coordinator, oauth, mounts, mcpHandler };
const app = createApp(dependencies);

afterAll(async () => {
  await mcpHandler.close();
  await coordinator.close();
  await database.close();
});

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Host', PUBLIC_HOST);
  return await app.request(`https://${PUBLIC_HOST}${path}`, { ...init, headers });
}

describe('HTTP security boundaries', () => {
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
