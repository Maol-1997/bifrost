import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig, type Config } from '../../src/server/config.js';
import { Coordinator } from '../../src/server/coordination.js';
import { createDatabase, type Database, type StoredCredential } from '../../src/server/database/index.js';
import { WEB_CLIENT_ID } from '../../src/server/clients/describe.js';
import { createApp } from '../../src/server/http/app.js';
import type { AppDependencies } from '../../src/server/http/context.js';
import { BrowserEventBus } from '../../src/server/http/events.js';
import { createHumanMcpHandler } from '../../src/server/mcp.js';
import { OAuthService } from '../../src/server/oauth.js';
import { canonicalResource, MCP_SCOPE } from '../../src/server/oauth-server/metadata.js';
import { connectUpstreamClient } from '../../src/server/providers/mcp-client.js';
import { mountProviders, PROVIDER_REGISTRY } from '../../src/server/providers/registry.js';
import type { ProviderId } from '../../src/server/providers/types.js';
import { UpstreamClientPool } from '../../src/server/providers/upstream-pool.js';
import { RedisRuntime } from '../../src/server/redis.js';
import { reconcileAutoPoliciesInBackground } from '../../src/server/tools/auto-policy.js';
import { createRedisToolCacheStore } from '../../src/server/tools/cache-store.js';
import type { ToolPolicyState } from '../../src/server/tools/catalog.js';
import { ToolDiscoveryService } from '../../src/server/tools/discovery.js';
import { modernRequestBody, modernRequestHeaders, type McpResponseBody } from '../helpers/mcp-protocol.js';
import type { IntegrationEnvironment } from './environment.js';
import { FakeUpstream } from './fake-upstream.js';

const PUBLIC_HOST = 'bifrost.integration.test';
const PUBLIC_URL = `https://${PUBLIC_HOST}`;
const OAUTH_CLIENT_ID = 'integration-agent';

type ProviderOAuthDependencies = NonNullable<ConstructorParameters<typeof OAuthService>[3]>;

/**
 * Sends provider MCP traffic to the fake upstream while leaving the registry,
 * its HTTPS URLs and every other request untouched. Production modules run
 * unchanged; only the network underneath them is different.
 */
function routeProviderTraffic(upstreamUrl: string): () => void {
  const originalFetch = globalThis.fetch;
  const providerUrls = PROVIDER_REGISTRY.map((provider) => provider.mcpUrl);
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!providerUrls.some((candidate) => url.startsWith(candidate))) return originalFetch(input, init);
    const rerouted = `${upstreamUrl}/mcp`;
    return input instanceof Request ? originalFetch(new Request(rerouted, input), init) : originalFetch(rerouted, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

export type McpResponse = { status: number; body: McpResponseBody };

export type IntegrationHarness = {
  config: Config;
  database: Database;
  toolDiscovery: ToolDiscoveryService;
  upstreamClients: UpstreamClientPool;
  upstream: FakeUpstream;
  createUser(): Promise<string>;
  issueBearer(userId: string): Promise<string>;
  connectProvider(userId: string, credential?: Partial<StoredCredential>, providerId?: ProviderId): Promise<void>;
  decideTools(
    adminUserId: string,
    decisions: Readonly<Record<string, ToolPolicyState>>,
    providerId?: ProviderId,
  ): Promise<void>;
  /** A real browser session cookie value for this user. */
  createSessionCookie(userId: string): Promise<string>;
  /** Any request to the app on its public origin. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Disconnects through the browser route, with a real session cookie. */
  disconnectProvider(userId: string, providerId?: ProviderId): Promise<number>;
  listTools(bearer: string): Promise<McpResponse>;
  callTool(bearer: string, name: string, toolArguments: Record<string, unknown>): Promise<McpResponse>;
  close(): Promise<void>;
};

export async function createIntegrationHarness(options: {
  environment: IntegrationEnvironment;
  providerOAuth?: Partial<ProviderOAuthDependencies>;
}): Promise<IntegrationHarness> {
  const upstream = new FakeUpstream();
  const upstreamUrl = await upstream.start();
  const restoreFetch = routeProviderTraffic(upstreamUrl);
  const config: Config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL,
    DATABASE_URL: options.environment.databaseUrl,
    REDIS_URL: options.environment.redisUrl,
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    GITHUB_CLIENT_ID: 'integration-github-client',
    GITHUB_CLIENT_SECRET: 'integration-github-secret',
  });
  const redis = await RedisRuntime.connect({ required: true, url: options.environment.redisUrl });
  if (!redis) throw new Error('Redis is required for integration tests');
  const coordinator = new Coordinator(redis.commands);
  const database = createDatabase(config);
  const mounts = mountProviders();
  const oauth = new OAuthService(config, database, coordinator, {
    ...unexpectedProviderOAuth(),
    ...options.providerOAuth,
  });
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
    store: createRedisToolCacheStore(redis.commands),
    onFreshTools: (providerId, tools) =>
      reconcileAutoPoliciesInBackground({
        providerId,
        tools,
        dependencies: { config, database, coordinator, events },
      }),
  });
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
    redis,
  };
  const app = createApp(dependencies);
  await database.upsertOAuthClient({
    clientId: OAUTH_CLIENT_ID,
    clientName: 'Integration agent',
    redirectUris: ['http://127.0.0.1/callback'],
    registrationKind: 'dynamic',
    metadataExpiresAt: undefined,
  });

  return {
    config,
    database,
    toolDiscovery,
    upstreamClients,
    upstream,

    async createUser(): Promise<string> {
      const userId = randomUUID();
      await database.ensureDevelopmentUser(userId);
      return userId;
    },

    /** A bearer token issued through the same grant store the consent screen uses. */
    async issueBearer(userId): Promise<string> {
      const tokens = await database.authorizeOAuthGrant({
        userId,
        clientId: OAUTH_CLIENT_ID,
        scopes: [MCP_SCOPE],
        resource: canonicalResource(PUBLIC_URL),
      });
      return tokens.accessToken;
    },

    async connectProvider(userId, credential = {}, providerId = 'github'): Promise<void> {
      await database.saveCredential(userId, providerId, {
        accessToken: `access-${randomUUID()}`,
        scopes: [],
        ...credential,
      });
    },

    /** Reviews the live upstream catalog the way an administrator would and decides every listed tool. */
    async decideTools(adminUserId, decisions, providerId = 'github'): Promise<void> {
      const { tools } = await toolDiscovery.discoverProviderFresh({ userId: adminUserId, providerId });
      await database.setToolPolicies(
        tools
          .filter((tool) => decisions[tool.name] !== undefined)
          .map((tool) => ({
            providerId,
            toolName: tool.name,
            fingerprint: tool.fingerprint,
            contract: tool.contract,
            state: decisions[tool.name]!,
            updatedByUserId: adminUserId,
          })),
      );
    },

    async createSessionCookie(userId): Promise<string> {
      const session = await database.createSession(userId, WEB_CLIENT_ID);
      return `bifrost_session=${session.token}`;
    },

    async request(path, init = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      headers.set('Host', PUBLIC_HOST);
      return app.request(`${PUBLIC_URL}${path}`, { ...init, headers });
    },

    async disconnectProvider(userId, providerId = 'github'): Promise<number> {
      const session = await database.createSession(userId, WEB_CLIENT_ID);
      const response = await app.request(`${PUBLIC_URL}/api/connections/${providerId}/disconnect`, {
        method: 'POST',
        headers: { Host: PUBLIC_HOST, Cookie: `bifrost_session=${session.token}` },
      });
      return response.status;
    },

    async listTools(bearer): Promise<McpResponse> {
      return mcpRequest(app, bearer, 'tools/list', {});
    },

    async callTool(bearer, name, toolArguments): Promise<McpResponse> {
      return mcpRequest(app, bearer, 'tools/call', { name, arguments: toolArguments });
    },

    async close(): Promise<void> {
      restoreFetch();
      await mcpHandler.close();
      await upstreamClients.close();
      await events.close();
      await redis.close();
      await database.close();
      await upstream.close();
    },
  };
}

let requestId = 0;

async function mcpRequest(
  app: ReturnType<typeof createApp>,
  bearer: string,
  method: string,
  params: Record<string, unknown>,
): Promise<McpResponse> {
  requestId += 1;
  const body = modernRequestBody(requestId, method, params);
  const response = await app.request(`${PUBLIC_URL}/mcp`, {
    method: 'POST',
    headers: { ...modernRequestHeaders(body), Host: PUBLIC_HOST, Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as McpResponseBody) : {} };
}

/** Provider token endpoints are never reached from tests; a test that needs one injects it. */
function unexpectedProviderOAuth(): ProviderOAuthDependencies {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected provider OAuth call in an integration test');
  };
  return { authorizationCodeGrant: unexpected, refreshTokenGrant: unexpected, readAccountLabel: unexpected };
}
