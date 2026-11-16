import './environment.js';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { Coordinator } from './coordination.js';
import { createDatabase } from './database/index.js';
import { DatabaseMaintenance } from './database/maintenance.js';
import { createApp } from './http/app.js';
import type { AppDependencies } from './http/context.js';
import { BrowserEventBus } from './http/events.js';
import { errorSummary, logger } from './logger.js';
import { createHumanMcpHandler } from './mcp.js';
import { OAuthService } from './oauth.js';
import { connectUpstreamClient } from './providers/mcp-client.js';
import { assertPrefixInvariant, mountProviders } from './providers/registry.js';
import { UpstreamClientPool } from './providers/upstream-pool.js';
import { RedisRuntime } from './redis.js';
import { isAccessRestricted } from './security/access.js';
import { SHUTDOWN_DEADLINE_MS, shutdownServer } from './shutdown.js';
import { createInMemoryToolCacheStore, createRedisToolCacheStore } from './tools/cache-store.js';
import { reconcileAutoPoliciesInBackground } from './tools/auto-policy.js';
import { ToolDiscoveryService } from './tools/discovery.js';

async function main(): Promise<void> {
  const config = loadConfig();
  assertPrefixInvariant();
  const mounts = mountProviders();
  const database = createDatabase(config);
  const redis = await RedisRuntime.connect({
    required: config.NODE_ENV === 'production',
    ...(config.REDIS_URL ? { url: config.REDIS_URL } : {}),
  });
  const coordinator = new Coordinator(redis?.commands);
  logDeploymentWarnings(config);

  if (config.NODE_ENV === 'development' && config.BIFROST_DEV_USER_ID) {
    await database.ensureDevelopmentUser(config.BIFROST_DEV_USER_ID);
    logger.warn({ userId: config.BIFROST_DEV_USER_ID }, 'Development user header authentication is enabled');
  }

  const oauth = new OAuthService(config, database, coordinator);
  const events = new BrowserEventBus(redis);
  await events.start();
  const upstreamClients = new UpstreamClientPool({
    connect: connectUpstreamClient,
    idleTtlMs: config.UPSTREAM_CLIENT_IDLE_SECONDS * 1000,
    maxClients: config.UPSTREAM_CLIENT_MAX,
  });
  const toolDiscovery = new ToolDiscoveryService({
    oauth,
    mounts,
    upstreamClients,
    store: redis ? createRedisToolCacheStore(redis.commands) : createInMemoryToolCacheStore(),
    onFreshTools: (providerId, tools) =>
      reconcileAutoPoliciesInBackground({
        providerId,
        tools,
        dependencies: { config, database, coordinator, events },
      }),
  });
  const maintenance = new DatabaseMaintenance({
    deleteExpiredAuthState: () => database.deleteExpiredAuthState(),
    withLock: (key, operation) => coordinator.withLock(key, operation),
  });
  maintenance.start();
  const mcpHandler = createHumanMcpHandler({
    config,
    database,
    coordinator,
    oauth,
    mounts,
    toolDiscovery,
    upstreamClients,
  });
  const dependencies: AppDependencies = {
    config,
    database,
    coordinator,
    oauth,
    mounts,
    mcpHandler,
    events,
    toolDiscovery,
    upstreamClients,
    ...(redis ? { redis } : {}),
  };
  const app = createApp(dependencies);
  const server = serve(
    {
      fetch: app.fetch,
      hostname: '0.0.0.0',
      port: config.PORT,
    },
    ({ port }) => logger.info({ port }, 'Bifrost listening'),
  );

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    // Event streams never finish on their own, so they would hold the drain
    // open until the deadline.
    events.endStreams();
    shutdownPromise ??= shutdownServer({
      server,
      deadlineMs: SHUTDOWN_DEADLINE_MS,
      dependencies: [
        { name: 'database maintenance', close: () => maintenance.close() },
        { name: 'MCP handler', close: () => mcpHandler.close() },
        { name: 'upstream MCP clients', close: () => upstreamClients.close() },
        { name: 'browser events', close: () => events.close() },
        ...(redis ? [{ name: 'Redis', close: () => redis.close() }] : []),
        { name: 'database', close: () => database.close() },
      ],
    });
    return shutdownPromise;
  };
  const handleShutdownSignal = (): void => {
    void shutdown().catch((error: unknown) => {
      process.exitCode = 1;
      logger.error(errorSummary(error), 'Graceful shutdown failed');
    });
  };
  process.once('SIGTERM', handleShutdownSignal);
  process.once('SIGINT', handleShutdownSignal);
}

function logDeploymentWarnings(config: ReturnType<typeof loadConfig>): void {
  if (!isAccessRestricted(config.accessPolicy)) {
    logger.warn(
      {},
      'Sign-in is open to any verified Google account. Set ALLOWED_EMAIL_DOMAINS or ALLOWED_EMAILS to restrict it',
    );
  }
  if (config.adminEmails.size === 0) {
    logger.warn(
      {},
      'No administrators configured. Every discovered provider tool remains blocked until ADMIN_EMAILS is set',
    );
  }
}

await main();
