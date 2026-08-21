import { describe, expect, it, vi } from 'vitest';
import { BrowserEventBus, type BrowserEvent } from '../src/server/http/events.js';

describe('BrowserEventBus', () => {
  it('delivers an emitted event to every listener of that user', () => {
    const bus = new BrowserEventBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.subscribe('user-a', first);
    bus.subscribe('user-a', second);

    bus.emit('user-a', 'providers-changed');

    expect(first).toHaveBeenCalledExactlyOnceWith('providers-changed');
    expect(second).toHaveBeenCalledExactlyOnceWith('providers-changed');
  });

  it('does not deliver another user\'s event', () => {
    const bus = new BrowserEventBus();
    const listener = vi.fn();
    bus.subscribe('user-a', listener);

    bus.emit('user-b', 'providers-changed');

    expect(listener).not.toHaveBeenCalled();
  });

  it('broadcasts to every subscribed user', () => {
    const bus = new BrowserEventBus();
    const events: BrowserEvent[] = [];
    bus.subscribe('user-a', (event) => events.push(event));
    bus.subscribe('user-b', (event) => events.push(event));

    bus.broadcast('admin-tools-changed');

    expect(events).toEqual(['admin-tools-changed', 'admin-tools-changed']);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new BrowserEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe('user-a', listener);

    unsubscribe();
    bus.emit('user-a', 'clients-changed');
    bus.broadcast('clients-changed');

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the remaining listener when one of two unsubscribes', () => {
    const bus = new BrowserEventBus();
    const removed = vi.fn();
    const kept = vi.fn();
    const unsubscribe = bus.subscribe('user-a', removed);
    bus.subscribe('user-a', kept);

    unsubscribe();
    bus.emit('user-a', 'providers-changed');

    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledExactlyOnceWith('providers-changed');
  });
});
