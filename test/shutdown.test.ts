import type { ServerType } from '@hono/node-server';
import { describe, expect, it, vi } from 'vitest';
import { shutdownServer } from '../src/server/shutdown.js';

function deferredServerClose(): {
  server: ServerType;
  finish: (error?: Error) => void;
} {
  let finish: (error?: Error) => void = () => undefined;
  const server = {
    close: (callback: (error?: Error) => void) => {
      finish = callback;
    },
  } as unknown as ServerType;
  return { server, finish: (error) => { finish(error); } };
}

describe('graceful shutdown', () => {
  it('waits for HTTP requests to drain before closing dependencies in order', async () => {
    const drainingServer = deferredServerClose();
    const events: string[] = [];
    const dependencies = ['MCP handler', 'coordinator', 'database'].map((name) => ({
      name,
      close: vi.fn(() => {
        events.push(name);
        return Promise.resolve();
      }),
    }));

    const shutdown = shutdownServer({ server: drainingServer.server, dependencies });
    expect(events).toEqual([]);
    drainingServer.finish();
    await shutdown;
    expect(events).toEqual(['MCP handler', 'coordinator', 'database']);
  });

  it('reports failures in teardown order after attempting every close', async () => {
    const drainingServer = deferredServerClose();
    const httpError = new Error('HTTP close failed');
    const mcpError = new Error('MCP close failed');
    const databaseError = new Error('database close failed');
    const dependencies = [
      { name: 'MCP handler', close: () => Promise.reject(mcpError) },
      { name: 'coordinator', close: () => Promise.resolve() },
      { name: 'database', close: () => Promise.reject(databaseError) },
    ];

    const shutdown = shutdownServer({ server: drainingServer.server, dependencies });
    drainingServer.finish(httpError);

    await expect(shutdown).rejects.toMatchObject({
      message: 'Shutdown failed: HTTP server, MCP handler, database',
      errors: [httpError, mcpError, databaseError],
    });
  });
});
