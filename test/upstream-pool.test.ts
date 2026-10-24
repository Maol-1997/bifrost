import { SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_REGISTRY } from '../src/server/providers/registry.js';
import type { ProviderDefinition } from '../src/server/providers/types.js';
import { UpstreamClientPool, type PooledUpstreamClient } from '../src/server/providers/upstream-pool.js';

const github = PROVIDER_REGISTRY.find((provider) => provider.id === 'github')!;
const linear = PROVIDER_REGISTRY.find((provider) => provider.id === 'linear')!;
const RESULT: CallToolResult = { content: [{ type: 'text', text: 'ok' }] };

type FakeClient = Pick<PooledUpstreamClient, 'listTools' | 'onclose' | 'transport'> & {
  accessToken: string;
  callTool: ReturnType<typeof vi.fn<() => Promise<CallToolResult>>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

function fakeConnector(options: { sessions?: boolean } = {}) {
  const clients: FakeClient[] = [];
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const connect = vi.fn(async (_provider: ProviderDefinition, accessToken: string): Promise<PooledUpstreamClient> => {
    if (gate) await gate;
    const client = {
      accessToken,
      callTool: vi.fn(async () => RESULT),
      listTools: vi.fn(async () => ({ tools: [] })),
      close: vi.fn(async () => undefined),
      transport: { sessionId: options.sessions === true ? `session-${clients.length + 1}` : undefined },
    } as unknown as FakeClient;
    clients.push(client);
    return client as unknown as PooledUpstreamClient;
  });
  return {
    clients,
    connect,
    /** Holds every connect until `open()`, so a test can pile callers onto one in-flight connection. */
    hold(): void { gate = new Promise((resolve) => { release = resolve; }); },
    open(): void { release?.(); gate = undefined; },
  };
}

let pool: UpstreamClientPool | undefined;

afterEach(async () => {
  await pool?.close();
  pool = undefined;
});

function createPool(connector: ReturnType<typeof fakeConnector>, options: { maxClients?: number; now?: () => number } = {}): UpstreamClientPool {
  pool = new UpstreamClientPool({
    connect: connector.connect,
    idleTtlMs: 300_000,
    maxClients: options.maxClients ?? 10,
    ...(options.now ? { now: options.now } : {}),
  });
  return pool;
}

const request = (userId: string, accessToken = `token-${userId}`, provider = github) => ({ userId, provider, accessToken });
const call = async (clients: UpstreamClientPool, userId: string, accessToken?: string) => (
  clients.withClient(request(userId, accessToken), async (client) => client.callTool({ name: 'echo', arguments: {} }))
);

describe('upstream client pool', () => {
  it('reuses one connection per user and provider across calls', async () => {
    const connector = fakeConnector();
    const clients = createPool(connector);

    await call(clients, 'alice');
    await call(clients, 'alice');
    await clients.withClient(request('alice', 'token-alice', linear), async () => undefined);
    await call(clients, 'bob');

    expect({ connects: connector.connect.mock.calls.map(([provider, token]) => `${provider.id}:${token}`), calls: connector.clients[0]!.callTool.mock.calls.length })
      .toEqual({ connects: ['github:token-alice', 'linear:token-alice', 'github:token-bob'], calls: 2 });
  });

  it('opens a single connection for concurrent first calls', async () => {
    const connector = fakeConnector();
    const clients = createPool(connector);
    connector.hold();

    const calls = [call(clients, 'alice'), call(clients, 'alice'), call(clients, 'alice')];
    connector.open();
    await Promise.all(calls);

    expect({ connects: connector.connect.mock.calls.length, calls: connector.clients[0]!.callTool.mock.calls.length })
      .toEqual({ connects: 1, calls: 3 });
  });

  it('replaces the connection when the access token changes, closing the old one', async () => {
    const connector = fakeConnector();
    const clients = createPool(connector);

    await call(clients, 'alice', 'before-refresh');
    await call(clients, 'alice', 'after-refresh');

    expect(connector.clients.map((client) => ({ token: client.accessToken, closed: client.close.mock.calls.length })))
      .toEqual([{ token: 'before-refresh', closed: 1 }, { token: 'after-refresh', closed: 0 }]);
  });

  it('runs a failed operation once, retires its connection, and reconnects only for the next call', async () => {
    const connector = fakeConnector();
    const clients = createPool(connector);
    await call(clients, 'alice');
    const failure = new Error('socket hang up');
    connector.clients[0]!.callTool.mockRejectedValueOnce(failure);

    await expect(call(clients, 'alice')).rejects.toBe(failure);
    const afterFailure = { calls: connector.clients[0]!.callTool.mock.calls.length, closed: connector.clients[0]!.close.mock.calls.length, connects: connector.connect.mock.calls.length };
    await call(clients, 'alice');

    expect({ afterFailure, connects: connector.connect.mock.calls.length })
      .toEqual({ afterFailure: { calls: 2, closed: 1, connects: 1 }, connects: 2 });
  });

  it('reconnects before sending when the transport closed while idle', async () => {
    const connector = fakeConnector();
    const clients = createPool(connector);
    await call(clients, 'alice');

    connector.clients[0]!.onclose?.();
    await call(clients, 'alice');

    expect({ connects: connector.connect.mock.calls.length, oldCalls: connector.clients[0]!.callTool.mock.calls.length, newCalls: connector.clients[1]!.callTool.mock.calls.length })
      .toEqual({ connects: 2, oldCalls: 1, newCalls: 1 });
  });

  it('propagates a connection failure and tries again on the next call', async () => {
    const connector = fakeConnector();
    const clients = createPool(connector);
    connector.connect.mockRejectedValueOnce(new Error('connect refused'));

    await expect(call(clients, 'alice')).rejects.toThrow('connect refused');
    await expect(call(clients, 'alice')).resolves.toBe(RESULT);
    expect(connector.connect).toHaveBeenCalledTimes(2);
  });

  it('lets a caller give up on a pending connection without cutting off the others', async () => {
    const connector = fakeConnector();
    const clients = createPool(connector);
    connector.hold();
    const controller = new AbortController();

    const abandoned = clients.withClient({ ...request('alice'), signal: controller.signal }, async () => 'never');
    const patient = call(clients, 'alice');
    controller.abort(new Error('client went away'));
    await expect(abandoned).rejects.toThrow('client went away');
    connector.open();

    await expect(patient).resolves.toBe(RESULT);
    expect({ connects: connector.connect.mock.calls.length, closed: connector.clients[0]!.close.mock.calls.length })
      .toEqual({ connects: 1, closed: 0 });
  });

  it('closes a connection when its credential is invalidated', async () => {
    const connector = fakeConnector();
    const clients = createPool(connector);
    await call(clients, 'alice');

    await clients.invalidate('alice', 'github');
    await call(clients, 'alice');

    expect({ closed: connector.clients[0]!.close.mock.calls.length, connects: connector.connect.mock.calls.length })
      .toEqual({ closed: 1, connects: 2 });
  });

  it('closes only connections idle for the configured time', async () => {
    let now = 0;
    const connector = fakeConnector();
    const clients = createPool(connector, { now: () => now });
    await call(clients, 'alice');
    now = 200_000;
    await call(clients, 'bob');

    now = 300_000;
    clients.closeIdle();
    await vi.waitFor(() => { expect(connector.clients[0]!.close).toHaveBeenCalledOnce(); });

    expect({ size: clients.size, bobClosed: connector.clients[1]!.close.mock.calls.length }).toEqual({ size: 1, bobClosed: 0 });
  });

  it('keeps at most the configured number, closing the least recently used idle connection', async () => {
    const connector = fakeConnector();
    const clients = createPool(connector, { maxClients: 2 });
    await call(clients, 'alice');
    await call(clients, 'bob');
    await call(clients, 'alice');

    await call(clients, 'carol');

    await vi.waitFor(() => { expect(connector.clients[1]!.close).toHaveBeenCalledOnce(); });
    expect({ size: clients.size, aliceClosed: connector.clients[0]!.close.mock.calls.length }).toEqual({ size: 2, aliceClosed: 0 });
  });

  it('never closes a connection with a call in flight, even over the cap', async () => {
    const connector = fakeConnector();
    const clients = createPool(connector, { maxClients: 1 });
    let finish = (): void => undefined;
    const running = clients.withClient(request('alice'), async () => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.waitFor(() => { expect(connector.clients).toHaveLength(1); });

    await call(clients, 'bob');
    const whileRunning = connector.clients[0]!.close.mock.calls.length;
    finish();
    await running;

    expect({ whileRunning, size: clients.size }).toEqual({ whileRunning: 0, size: 2 });
  });

  it('closes every connection on shutdown', async () => {
    const connector = fakeConnector();
    const clients = createPool(connector);
    await call(clients, 'alice');
    await call(clients, 'bob');

    await clients.close();

    expect(connector.clients.map((client) => client.close.mock.calls.length)).toEqual([1, 1]);
  });

  describe('a session the provider dropped', () => {
    const sessionNotFound = (): SdkHttpError => new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Session not found', { status: 404 });

    it('resends once on a fresh connection, since the provider processed nothing', async () => {
      const connector = fakeConnector({ sessions: true });
      const clients = createPool(connector);
      await call(clients, 'alice');
      connector.clients[0]!.callTool.mockRejectedValueOnce(sessionNotFound());

      await expect(call(clients, 'alice')).resolves.toBe(RESULT);
      expect({
        connects: connector.connect.mock.calls.length,
        callsPerClient: connector.clients.map((client) => client.callTool.mock.calls.length),
        oldClosed: connector.clients[0]!.close.mock.calls.length,
      }).toEqual({ connects: 2, callsPerClient: [2, 1], oldClosed: 1 });
    });

    it('does not resend a 404 from a client that never had a session', async () => {
      const connector = fakeConnector();
      const clients = createPool(connector);
      await call(clients, 'alice');
      connector.clients[0]!.callTool.mockRejectedValueOnce(sessionNotFound());

      await expect(call(clients, 'alice')).rejects.toBeInstanceOf(SdkHttpError);
      expect(connector.connect).toHaveBeenCalledOnce();
    });

    it('resends at most once', async () => {
      const connector = fakeConnector({ sessions: true });
      const clients = createPool(connector);
      await call(clients, 'alice');
      connector.clients[0]!.callTool.mockRejectedValueOnce(sessionNotFound());
      connector.connect.mockImplementationOnce(async () => {
        const client = { callTool: vi.fn(async () => { throw sessionNotFound(); }), listTools: vi.fn(), close: vi.fn(async () => undefined), transport: { sessionId: 'session-2' } };
        connector.clients.push(client as unknown as FakeClient);
        return client as unknown as PooledUpstreamClient;
      });

      await expect(call(clients, 'alice')).rejects.toBeInstanceOf(SdkHttpError);
      expect(connector.clients.map((client) => client.callTool.mock.calls.length)).toEqual([2, 1]);
    });
  });
});
