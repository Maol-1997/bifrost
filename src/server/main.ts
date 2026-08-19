import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { Coordinator } from './coordination.js';
import { Database } from './db.js';
import { createApp } from './http/app.js';
import type { AppDependencies } from './http/context.js';
import { logger } from './logger.js';
import { createHumanMcpHandler } from './mcp.js';
import { OAuthService } from './oauth.js';
import { assertPrefixInvariant, mountProviders } from './providers/registry.js';
import { isAccessRestricted } from './security/access.js';

async function main(): Promise<void> {
  const config = loadConfig();
  assertPrefixInvariant();
  const mounts = mountProviders();
  const database = new Database(config);
  const coordinator = new Coordinator();
  await coordinator.connect(config.REDIS_URL);
  logDeploymentWarnings(config);

  if (config.NODE_ENV === 'development' && config.BIFROST_DEV_USER_ID) {
    await database.ensureDevelopmentUser(config.BIFROST_DEV_USER_ID);
    logger.warn({ userId: config.BIFROST_DEV_USER_ID }, 'Development user header authentication is enabled');
  }

  const oauth = new OAuthService(config, database, coordinator);
  const mcpHandler = createHumanMcpHandler({ config, database, coordinator, oauth, mounts });
  const dependencies: AppDependencies = { config, database, coordinator, oauth, mounts, mcpHandler };
  const app = createApp(dependencies);
  const server = serve({
    fetch: app.fetch,
    hostname: '0.0.0.0',
    port: config.PORT,
  }, ({ port }) => logger.info({ port }, 'Bifrost listening'));

  let isShuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    server.close();
    await mcpHandler.close();
    await coordinator.close();
    await database.close();
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}

function logDeploymentWarnings(config: ReturnType<typeof loadConfig>): void {
  if (!isAccessRestricted(config.accessPolicy)) {
    logger.warn({}, 'Sign-in is open to any verified Google account. Set ALLOWED_EMAIL_DOMAINS or ALLOWED_EMAILS to restrict it');
  }
  if (config.adminEmails.size === 0) {
    logger.warn({}, 'No administrators configured. Every discovered provider tool remains blocked until ADMIN_EMAILS is set');
  }
}

await main();
