import { createClient, type RedisClientType } from 'redis';
import { errorSummary, logger } from './logger.js';

type RedisEvalOptions = {
  keys: string[];
  arguments?: string[];
};

type RedisSetOptions = {
  EX?: number;
  NX?: true;
  PX?: number;
};

export type RedisCommandsClient = {
  eval(script: string, options: RedisEvalOptions): Promise<unknown>;
  getDel(key: string): Promise<string | null>;
  publish(channel: string, message: string): Promise<number>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<string | null>;
};

export type RedisSubscriberClient = {
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
};

export type RedisConnectionOptions = {
  required: boolean;
  url?: string;
};

export class RedisRuntime {
  readonly commands: RedisCommandsClient;
  readonly subscriber: RedisSubscriberClient;
  private readonly commandConnection: RedisClientType;
  private readonly subscriberConnection: RedisClientType;

  get isReady(): boolean {
    return this.commandConnection.isReady && this.subscriberConnection.isReady;
  }

  private constructor(url: string) {
    const commandReconnect = failFastBeforeFirstReady();
    const subscriberReconnect = failFastBeforeFirstReady();
    this.commandConnection = createClient(redisClientOptions(url, commandReconnect));
    this.subscriberConnection = this.commandConnection.duplicate(
      redisClientOptions(url, subscriberReconnect),
    );
    this.commands = this.commandConnection;
    this.subscriber = this.subscriberConnection;
    this.commandConnection.on('ready', commandReconnect.markReady);
    this.subscriberConnection.on('ready', subscriberReconnect.markReady);
    this.commandConnection.on('error', (error) => logger.error(errorSummary(error), 'Redis command client error'));
    this.subscriberConnection.on('error', (error) => logger.error(errorSummary(error), 'Redis subscriber client error'));
  }

  static async connect(options: RedisConnectionOptions): Promise<RedisRuntime | undefined> {
    if (!options.url) {
      if (options.required) throw new Error('Redis is required but REDIS_URL is not configured');
      logger.warn({ mode: 'in-process' }, 'Redis is unconfigured; shared coordination and browser events are disabled');
      return undefined;
    }

    const runtime = new RedisRuntime(options.url);
    try {
      await runtime.commandConnection.connect();
      await runtime.subscriberConnection.connect();
      return runtime;
    } catch (error) {
      await runtime.closeAfterFailedConnect();
      if (options.required) throw error;
      logger.warn(errorSummary(error), 'Redis unavailable; degraded to in-process behavior');
      return undefined;
    }
  }

  async close(): Promise<void> {
    await Promise.all([
      closeClient(this.subscriberConnection),
      closeClient(this.commandConnection),
    ]);
  }

  private async closeAfterFailedConnect(): Promise<void> {
    const results = await Promise.allSettled([
      closeClient(this.subscriberConnection),
      closeClient(this.commandConnection),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') logger.warn(errorSummary(result.reason), 'Failed to close Redis client after connection failure');
    }
  }
}

async function closeClient(client: RedisClientType): Promise<void> {
  if (client.isOpen) await client.close();
}

export function failFastBeforeFirstReady(): {
  markReady: () => void;
  strategy: (retries: number, cause: Error) => number | Error;
} {
  let connectedOnce = false;
  return {
    markReady: () => { connectedOnce = true; },
    strategy: (retries, cause) => (
      connectedOnce ? Math.min(50 * 2 ** retries, 3_000) : cause
    ),
  };
}

export function redisClientOptions(
  url: string,
  reconnect: ReturnType<typeof failFastBeforeFirstReady>,
) {
  return {
    url,
    // Shared coordination cannot wait in a process-local queue. Failing while
    // disconnected lets health checks drain the replica and local SSE delivery
    // continue instead of hanging requests until Redis returns.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: reconnect.strategy,
    },
  } as const;
}
