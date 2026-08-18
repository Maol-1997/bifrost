import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { loadConfig } from './config.js';
import { Coordinator } from './coordination.js';
import { Database } from './db.js';
import { authenticateBrowser } from './http/auth.js';
import type { AppDependencies, RequestContext } from './http/context.js';
import { isAllowedHost, json, setSecurityHeaders } from './http/respond.js';
import { errorSummary, logger } from './logger.js';
import { createHumanMcpHandler } from './mcp.js';
import { OAuthService } from './oauth.js';
import { assertPrefixInvariant, mountProviders } from './providers/registry.js';
import { handleApiRoutes } from './routes/api-routes.js';
import { handleMcpRoute } from './routes/mcp-route.js';
import { handleOAuthConsentRoutes, handleOAuthServerRoutes } from './routes/oauth-server-routes.js';
import { handlePublicRoutes } from './routes/public-routes.js';
import { isAccessRestricted } from './security/access.js';

async function main(): Promise<void> {
  const config = loadConfig();
  assertPrefixInvariant();
  const mounts = mountProviders();
  const database = new Database(config);
  const coordinator = new Coordinator();
  await coordinator.connect(config.REDIS_URL);
  if (!isAccessRestricted(config.accessPolicy)) {
    logger.warn({}, 'Sign-in is open to any verified Google account. Set ALLOWED_EMAIL_DOMAINS or ALLOWED_EMAILS to restrict it');
  }
  if (config.writeToolAllowlist.size === 0) {
    logger.warn({}, 'No deployment ceiling on write tools. Each user decides per tool in Integrations, starting off. Set WRITE_TOOL_ALLOWLIST to restrict which ones they may enable');
  }
  if (config.NODE_ENV === 'development' && config.BIFROST_DEV_USER_ID) {
    await database.ensureDevelopmentUser(config.BIFROST_DEV_USER_ID);
    logger.warn({ userId: config.BIFROST_DEV_USER_ID }, 'Development user header authentication is enabled');
  }
  const oauth = new OAuthService(config, database, coordinator);
  const mcpHandler = createHumanMcpHandler({ config, database, coordinator, oauth, mounts });
  const nodeMcpHandler = toNodeHandler(mcpHandler, { onerror: (error) => logger.error(errorSummary(error), 'Node MCP adapter error') });
  const deps: AppDependencies = { config, database, coordinator, oauth, mounts, nodeMcpHandler };
  const server = createServer((request, response) => {
    void route({ request, response, url: new URL(request.url ?? '/', config.PUBLIC_URL), deps }).catch((error: unknown) => {
      logger.error(errorSummary(error), 'HTTP request failed');
      if (!response.headersSent) json(response, 500, { error: 'Internal server error' });
      else response.end();
    });
  });
  server.listen(config.PORT, '0.0.0.0', () => logger.info({ port: config.PORT }, 'Bifrost listening'));

  const shutdown = async (): Promise<void> => {
    server.close();
    await mcpHandler.close();
    await coordinator.close();
    await database.close();
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}

/**
 * One port, three kinds of traffic. The order is the authentication design:
 * public and OAuth-server routes need nothing, `/mcp` takes only a bearer token,
 * and everything after `authenticateBrowser` takes only the session cookie.
 * The two authenticators resolve against different tables and must stay apart.
 */
async function route(context: RequestContext): Promise<void> {
  const { request, response, deps } = context;
  setSecurityHeaders(response);
  if (!isAllowedHost(request, deps.config)) return json(response, 403, { error: 'Host is not allowed' });

  if (await handlePublicRoutes(context)) return;
  if (await handleOAuthServerRoutes(context)) return;
  if (await handleMcpRoute(context)) return;

  const identity = await authenticateBrowser(request, deps.database, deps.config);
  if (await handleOAuthConsentRoutes(context, identity)) return;
  if (!identity) return json(response, 401, { error: 'Authentication required' });
  if (await handleApiRoutes({ ...context, identity })) return;
  return json(response, 404, { error: 'Not found' });
}

await main();
