import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import type { Database } from '../src/server/database/index.js';
import { createBrowserRoutes } from '../src/server/http/browser.js';
import type { AppDependencies, AppEnv } from '../src/server/http/context.js';
import { BrowserEventBus } from '../src/server/http/events.js';

const USER_ID = randomUUID();
const CURRENT_SESSION_ID = randomUUID();
const OTHER_SESSION_ID = randomUUID();
const SESSION_TOKEN = 'session-token';
const RENEWED_UNTIL = new Date('2030-02-01T00:00:00.000Z');

describe('browser session renewal', () => {
  it('renews the current row and reissues its 30-day cookie', async () => {
    const harness = renewalApp();

    const response = await harness.app.request(`/api/clients/browser/${CURRENT_SESSION_ID}/renew`, {
      method: 'POST',
      headers: { cookie: `bifrost_session=${SESSION_TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(harness.renewSession).toHaveBeenCalledExactlyOnceWith(USER_ID, CURRENT_SESSION_ID);
    expect(response.headers.get('set-cookie')).toContain(
      'bifrost_session=session-token; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax',
    );
  });

  it('rejects renewal from a different browser without touching its row or cookie', async () => {
    const harness = renewalApp();

    const response = await harness.app.request(`/api/clients/browser/${OTHER_SESSION_ID}/renew`, {
      method: 'POST',
      headers: { cookie: `bifrost_session=${SESSION_TOKEN}` },
    });

    expect(response.status).toBe(409);
    expect(harness.renewSession).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

function renewalApp() {
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL: 'https://bifrost.example',
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  });
  const renewSession = vi.fn(async () => RENEWED_UNTIL);
  const database = {
    resolveSessionAndTouch: vi.fn(async () => ({
      sessionId: CURRENT_SESSION_ID,
      userId: USER_ID,
      email: 'sam@example.test',
      clientId: 'bifrost-web',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    })),
    renewSession,
  } as unknown as Database;
  const dependencies = {
    config,
    database,
    events: new BrowserEventBus(),
    mounts: [],
  } as unknown as AppDependencies;
  const app = new Hono<AppEnv>();
  app.use('*', async (context, next) => {
    context.set('dependencies', dependencies);
    await next();
  });
  app.route('/', createBrowserRoutes());
  return { app, renewSession };
}
