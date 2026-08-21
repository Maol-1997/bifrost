/** Names what changed; the browser invalidates the matching query and refetches the truth. */
export type BrowserEvent = 'providers-changed' | 'clients-changed' | 'admin-tools-changed';

type BrowserEventListener = (event: BrowserEvent) => void;

/**
 * In-process fan-out from mutation handlers to open browser event streams.
 * The deployment is a single container; cross-instance fan-out would have to
 * go through Redis and is deliberately out of scope here.
 */
export class BrowserEventBus {
  private readonly listenersByUser = new Map<string, Set<BrowserEventListener>>();

  subscribe(userId: string, listener: BrowserEventListener): () => void {
    const listeners = this.listenersByUser.get(userId) ?? new Set<BrowserEventListener>();
    listeners.add(listener);
    this.listenersByUser.set(userId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listenersByUser.delete(userId);
    };
  }

  emit(userId: string, event: BrowserEvent): void {
    for (const listener of this.listenersByUser.get(userId) ?? []) listener(event);
  }

  broadcast(event: BrowserEvent): void {
    for (const listeners of this.listenersByUser.values()) {
      for (const listener of listeners) listener(event);
    }
  }
}
