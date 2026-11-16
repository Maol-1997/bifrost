import { randomUUID } from 'node:crypto';
import { errorSummary, logger } from '../logger.js';
import type { RedisCommandsClient, RedisSubscriberClient } from '../redis.js';

/** Names what changed; the browser invalidates the matching query and refetches the truth. */
export type BrowserEvent = 'providers-changed' | 'clients-changed' | 'admin-tools-changed';

type BrowserEventListener = (event: BrowserEvent) => void;

type BrowserEventRedis = {
  commands: Pick<RedisCommandsClient, 'publish'>;
  subscriber: RedisSubscriberClient;
};

type BrowserEventMessage = {
  version: 1;
  targetUserId: string;
  event: BrowserEvent;
  originId: string;
};

export const BROWSER_EVENTS_CHANNEL = 'bifrost:v1:browser-events';
const MESSAGE_VERSION = 1;
const BROADCAST_TARGET = '*';
const BROWSER_EVENTS = new Set<BrowserEvent>(['providers-changed', 'clients-changed', 'admin-tools-changed']);

export class BrowserEventBus {
  private readonly listenersByUser = new Map<string, Set<BrowserEventListener>>();
  private readonly originId = randomUUID();
  private started = false;

  constructor(private readonly redis?: BrowserEventRedis) {}

  async start(): Promise<void> {
    if (!this.redis || this.started) return;
    await this.redis.subscriber.subscribe(BROWSER_EVENTS_CHANNEL, (message) => this.receive(message));
    this.started = true;
  }

  async close(): Promise<void> {
    if (!this.redis || !this.started) return;
    await this.redis.subscriber.unsubscribe(BROWSER_EVENTS_CHANNEL);
    this.started = false;
  }

  subscribe(userId: string, listener: BrowserEventListener): () => void {
    const listeners = this.listenersByUser.get(userId) ?? new Set<BrowserEventListener>();
    listeners.add(listener);
    this.listenersByUser.set(userId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listenersByUser.delete(userId);
    };
  }

  async emit(userId: string, event: BrowserEvent): Promise<void> {
    this.deliver(userId, event);
    await this.publish({ version: MESSAGE_VERSION, targetUserId: userId, event, originId: this.originId });
  }

  async broadcast(event: BrowserEvent): Promise<void> {
    this.deliver(BROADCAST_TARGET, event);
    await this.publish({ version: MESSAGE_VERSION, targetUserId: BROADCAST_TARGET, event, originId: this.originId });
  }

  private deliver(target: string, event: BrowserEvent): void {
    if (target !== BROADCAST_TARGET) {
      for (const listener of this.listenersByUser.get(target) ?? []) listener(event);
      return;
    }
    for (const listeners of this.listenersByUser.values()) {
      for (const listener of listeners) listener(event);
    }
  }

  private async publish(message: BrowserEventMessage): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.commands.publish(BROWSER_EVENTS_CHANNEL, JSON.stringify(message));
    } catch (error) {
      logger.warn(errorSummary(error), 'Failed to publish browser event; local listeners were notified');
    }
  }

  private receive(serializedMessage: string): void {
    const message = parseMessage(serializedMessage);
    if (!message || message.originId === this.originId) return;
    this.deliver(message.targetUserId, message.event);
  }
}

function parseMessage(serializedMessage: string): BrowserEventMessage | undefined {
  try {
    const value: unknown = JSON.parse(serializedMessage);
    if (isBrowserEventMessage(value)) return value;
    logger.warn({}, 'Ignored invalid Redis browser event');
    return undefined;
  } catch (error) {
    logger.warn(errorSummary(error), 'Ignored malformed Redis browser event');
    return undefined;
  }
}

function isBrowserEventMessage(value: unknown): value is BrowserEventMessage {
  if (value === null || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.version === MESSAGE_VERSION &&
    typeof message.targetUserId === 'string' &&
    BROWSER_EVENTS.has(message.event as BrowserEvent) &&
    typeof message.originId === 'string'
  );
}
