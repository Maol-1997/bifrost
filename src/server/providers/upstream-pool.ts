import { SdkHttpError, type Client } from '@modelcontextprotocol/client';
import { errorSummary, logger } from '../logger.js';
import type { ProviderDefinition, ProviderId } from './types.js';

/**
 * The part of an SDK client the pool hands out. `onclose` is how a dead
 * connection is noticed, and the transport's session id tells a lost session
 * apart from a missing endpoint.
 */
export type PooledUpstreamClient = Pick<Client, 'callTool' | 'listTools' | 'close' | 'transport'> & {
  onclose?: (() => void) | undefined;
};

export type UpstreamConnector = (provider: ProviderDefinition, accessToken: string) => Promise<PooledUpstreamClient>;

export type UpstreamClientPoolOptions = {
  connect: UpstreamConnector;
  /** A client unused for this long is closed. */
  idleTtlMs: number;
  /** Least recently used idle clients are closed beyond this many. */
  maxClients: number;
  now?: () => number;
};

export type UpstreamClientRequest = {
  userId: string;
  provider: ProviderDefinition;
  accessToken: string;
  signal?: AbortSignal;
};

type Entry = {
  key: string;
  accessToken: string;
  client: Promise<PooledUpstreamClient>;
  inFlight: number;
  lastUsedAt: number;
  /** Set when the transport closed under us; the next caller reconnects before sending. */
  isDead: boolean;
  /** Out of the map; closes as soon as its last in-flight operation ends. */
  isRetired: boolean;
};

const MAX_SWEEP_INTERVAL_MS = 60_000;
/** What a Streamable HTTP server answers, before processing anything, for a session it no longer knows. */
const SESSION_NOT_FOUND_STATUS = 404;

/**
 * One connected upstream MCP client per user and provider, reused across tool
 * calls and listings instead of paying the connect handshake on every call.
 *
 * Reuse never weakens the no-retry rule: any failure retires the client, and an
 * operation the provider may have run is never sent twice. The one resend is
 * for a 404 on a client that held a session: a Streamable HTTP server answers
 * that for a session it dropped, without processing the request, so the
 * operation runs once more on a fresh connection. Otherwise reconnecting only
 * happens before a request is sent, when the entry is missing, idle-expired,
 * dead, or bound to an older access token.
 *
 * The SDK multiplexes concurrent requests over one client by JSON-RPC id, and
 * over Streamable HTTP each request is its own POST, so concurrent calls for the
 * same user and provider share a client instead of queueing for it.
 */
export class UpstreamClientPool {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly options: UpstreamClientPoolOptions) {
    this.now = options.now ?? Date.now;
    this.sweeper = setInterval(
      () => {
        this.closeIdle();
      },
      Math.min(options.idleTtlMs, MAX_SWEEP_INTERVAL_MS),
    );
    this.sweeper.unref();
  }

  get size(): number {
    return this.entries.size;
  }

  async withClient<T>(
    request: UpstreamClientRequest,
    operation: (client: PooledUpstreamClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.runOnce(request, async (client) => {
        try {
          return await operation(client);
        } catch (error) {
          throw isSessionNotFound(error, client) ? new SessionNotFoundError(error) : error;
        }
      });
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) throw error;
      return this.runOnce(request, operation);
    }
  }

  /** Closes the user's client for a provider; called when the credential behind it changes or goes away. */
  async invalidate(userId: string, providerId: ProviderId): Promise<void> {
    const entry = this.entries.get(entryKey(userId, providerId));
    if (entry) await this.retire(entry);
  }

  /** Closes every client idle past the TTL; the sweep timer runs it. */
  closeIdle(): void {
    const cutoff = this.now() - this.options.idleTtlMs;
    for (const entry of [...this.entries.values()]) {
      if (entry.inFlight === 0 && entry.lastUsedAt <= cutoff) void this.retire(entry);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.entries.values()].map(async (entry) => this.retire(entry)));
  }

  private async runOnce<T>(
    request: UpstreamClientRequest,
    operation: (client: PooledUpstreamClient) => Promise<T>,
  ): Promise<T> {
    const entry = this.acquire(request);
    entry.inFlight += 1;
    try {
      const client = await abortable(entry.client, request.signal);
      return await operation(client);
    } catch (error) {
      // The session may be half-broken, so the next caller starts from a fresh
      // connection. A caller giving up is not the connection's fault and must
      // not cut off others sharing it.
      if (request.signal?.aborted !== true) void this.retire(entry);
      throw error;
    } finally {
      entry.inFlight -= 1;
      entry.lastUsedAt = this.now();
      if (entry.isRetired && entry.inFlight === 0) void closeEntry(entry);
    }
  }

  private acquire(request: UpstreamClientRequest): Entry {
    const key = entryKey(request.userId, request.provider.id);
    const existing = this.entries.get(key);
    if (existing && !existing.isDead && existing.accessToken === request.accessToken) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    if (existing) void this.retire(existing);

    const entry: Entry = {
      key,
      accessToken: request.accessToken,
      client: this.options.connect(request.provider, request.accessToken),
      inFlight: 0,
      lastUsedAt: this.now(),
      isDead: false,
      isRetired: false,
    };
    entry.client.then(
      (client) => {
        client.onclose = () => {
          entry.isDead = true;
        };
      },
      () => {
        void this.retire(entry);
      },
    );
    this.entries.set(key, entry);
    this.closeOverflow(entry);
    return entry;
  }

  private closeOverflow(acquired: Entry): void {
    for (const entry of this.entries.values()) {
      if (this.entries.size <= this.options.maxClients) return;
      // A client in use is never cut off mid-call, nor is the one just opened
      // for this caller; the pool may briefly exceed its cap instead.
      if (entry.inFlight === 0 && entry !== acquired) void this.retire(entry);
    }
  }

  private async retire(entry: Entry): Promise<void> {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.isRetired) return;
    entry.isRetired = true;
    if (entry.inFlight === 0) await closeEntry(entry);
  }
}

/** Marks the first attempt's failure as safe to resend; the resend surfaces its own errors unwrapped. */
class SessionNotFoundError extends Error {
  constructor(cause: unknown) {
    super('Upstream session not found', { cause });
    this.name = 'SessionNotFoundError';
  }
}

function isSessionNotFound(error: unknown, client: PooledUpstreamClient): boolean {
  return (
    error instanceof SdkHttpError &&
    error.status === SESSION_NOT_FOUND_STATUS &&
    client.transport?.sessionId !== undefined
  );
}

function entryKey(userId: string, providerId: ProviderId): string {
  return `${providerId}:${userId}`;
}

async function closeEntry(entry: Entry): Promise<void> {
  try {
    const client = await entry.client;
    client.onclose = undefined;
    await client.close();
  } catch (error) {
    // A connection that never opened or fails to close has nothing left to release.
    logger.debug(errorSummary(error), 'Upstream MCP client closed with an error');
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
