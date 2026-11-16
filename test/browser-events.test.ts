import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_EVENTS_CHANNEL, BrowserEventBus, type BrowserEvent } from '../src/server/http/events.js';
import { logger } from '../src/server/logger.js';

type RedisMessageListener = (message: string) => void;

class FakeBrowserEventBroker {
  private readonly listeners = new Set<RedisMessageListener>();

  connection() {
    let listener: RedisMessageListener | undefined;
    return {
      commands: {
        publish: vi.fn(async (_channel: string, message: string) => {
          for (const subscribed of this.listeners) subscribed(message);
          return this.listeners.size;
        }),
      },
      subscriber: {
        subscribe: vi.fn(async (_channel: string, nextListener: RedisMessageListener) => {
          listener = nextListener;
          this.listeners.add(nextListener);
        }),
        unsubscribe: vi.fn(async () => {
          if (listener) this.listeners.delete(listener);
        }),
      },
    };
  }
}

describe('BrowserEventBus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers an emitted event to every listener of that user', async () => {
    const bus = new BrowserEventBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.subscribe('user-a', first);
    bus.subscribe('user-a', second);

    await bus.emit('user-a', 'providers-changed');

    expect(first).toHaveBeenCalledExactlyOnceWith('providers-changed');
    expect(second).toHaveBeenCalledExactlyOnceWith('providers-changed');
  });

  it("does not deliver another user's event", async () => {
    const bus = new BrowserEventBus();
    const listener = vi.fn();
    bus.subscribe('user-a', listener);

    await bus.emit('user-b', 'providers-changed');

    expect(listener).not.toHaveBeenCalled();
  });

  it('broadcasts to every subscribed user', async () => {
    const bus = new BrowserEventBus();
    const events: BrowserEvent[] = [];
    bus.subscribe('user-a', (event) => events.push(event));
    bus.subscribe('user-b', (event) => events.push(event));

    await bus.broadcast('admin-tools-changed');

    expect(events).toEqual(['admin-tools-changed', 'admin-tools-changed']);
  });

  it('stops delivering after unsubscribe', async () => {
    const bus = new BrowserEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe('user-a', listener);

    unsubscribe();
    await bus.emit('user-a', 'clients-changed');
    await bus.broadcast('clients-changed');

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the remaining listener when one of two unsubscribes', async () => {
    const bus = new BrowserEventBus();
    const removed = vi.fn();
    const kept = vi.fn();
    const unsubscribe = bus.subscribe('user-a', removed);
    bus.subscribe('user-a', kept);

    unsubscribe();
    await bus.emit('user-a', 'providers-changed');

    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledExactlyOnceWith('providers-changed');
  });

  it('delivers across instances while the publishing instance receives exactly once', async () => {
    const broker = new FakeBrowserEventBroker();
    const first = new BrowserEventBus(broker.connection());
    const second = new BrowserEventBus(broker.connection());
    const localListener = vi.fn();
    const remoteListener = vi.fn();
    first.subscribe('user-a', localListener);
    second.subscribe('user-a', remoteListener);
    await Promise.all([first.start(), second.start()]);

    await first.emit('user-a', 'providers-changed');

    expect(localListener).toHaveBeenCalledExactlyOnceWith('providers-changed');
    expect(remoteListener).toHaveBeenCalledExactlyOnceWith('providers-changed');
  });

  it('publishes a versioned broadcast envelope on the shared channel', async () => {
    const connection = new FakeBrowserEventBroker().connection();
    const bus = new BrowserEventBus(connection);

    await bus.broadcast('admin-tools-changed');

    expect(connection.commands.publish).toHaveBeenCalledOnce();
    const [channel, serializedMessage] = connection.commands.publish.mock.calls[0]!;
    const envelope: unknown = JSON.parse(serializedMessage);
    expect(envelope).toBeTypeOf('object');
    const eventEnvelope = envelope as Record<string, unknown>;
    expect(channel).toBe(BROWSER_EVENTS_CHANNEL);
    expect(eventEnvelope).toMatchObject({
      version: 1,
      targetUserId: '*',
      event: 'admin-tools-changed',
    });
    expect(eventEnvelope.originId).toBeTypeOf('string');
  });

  it('unsubscribes on close and stops receiving remote events', async () => {
    const broker = new FakeBrowserEventBroker();
    const first = new BrowserEventBus(broker.connection());
    const second = new BrowserEventBus(broker.connection());
    const listener = vi.fn();
    second.subscribe('user-a', listener);
    await Promise.all([first.start(), second.start()]);
    await second.close();

    await first.emit('user-a', 'clients-changed');

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps local delivery when Redis publish fails', async () => {
    const connection = new FakeBrowserEventBroker().connection();
    connection.commands.publish.mockRejectedValueOnce(new Error('connection lost'));
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const bus = new BrowserEventBus(connection);
    const listener = vi.fn();
    bus.subscribe('user-a', listener);

    await expect(bus.emit('user-a', 'providers-changed')).resolves.toBeUndefined();

    expect(listener).toHaveBeenCalledExactlyOnceWith('providers-changed');
    expect(warning).toHaveBeenCalledWith(
      { errorType: 'Error', message: 'connection lost' },
      'Failed to publish browser event; local listeners were notified',
    );
  });
});
