import { createMcpHandler, fromJsonSchema, LATEST_PROTOCOL_VERSION, McpServer, type AuthInfo, type JsonSchemaType, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { Coordinator } from './coordination.js';
import type { Database } from './database/index.js';
import { errorSummary, logger } from './logger.js';
import { OAuthService } from './oauth.js';
import type { ProviderMount } from './providers/types.js';
import type { DiscoveredTool } from './tools/catalog.js';
import { executeUserTool, loadVisibleUserTools } from './tools/user-toolset.js';

type HumanIdentityCommon = {
  userId: string;
  clientId: string;
  expiresAt: Date;
  token: string;
  scopes: readonly string[];
};

export type BrowserIdentity = { kind: 'browser'; sessionId: string } & HumanIdentityCommon;
export type AgentIdentity = { kind: 'agent'; grantId: string } & HumanIdentityCommon;

export function toAuthInfo(identity: AgentIdentity): AuthInfo {
  return {
    token: identity.token,
    clientId: identity.clientId,
    scopes: [...identity.scopes],
    expiresAt: Math.floor(identity.expiresAt.getTime() / 1000),
    extra: { userId: identity.userId },
  };
}

export function createHumanMcpHandler(dependencies: {
  config: Config;
  database: Database;
  coordinator: Coordinator;
  oauth: OAuthService;
  mounts: readonly ProviderMount[];
}): McpHttpHandler {
  return createMcpHandler(async (requestContext) => {
    const userId = requestContext.authInfo?.extra?.userId;
    if (typeof userId !== 'string') throw new Error('Authenticated user identity is missing');
    const tools = await loadVisibleUserTools({
      userId,
      dependencies,
      ...(requestContext.requestInfo ? { signal: requestContext.requestInfo.signal } : {}),
    });
    const server = new McpServer(
      { name: 'bifrost', version: '0.1.0' },
      { capabilities: { tools: {} }, instructions: `Bifrost unified internal gateway. Protocol ${LATEST_PROTOCOL_VERSION}.` },
    );
    for (const tool of tools) registerTool(server, tool, { userId, authInfo: requestContext.authInfo, dependencies });
    return server;
  }, {
    legacy: 'reject',
    responseMode: 'json',
    onerror: (error) => logger.error(errorSummary(error), 'MCP handler error'),
  });
}

type ToolRegistration = {
  userId: string;
  authInfo: AuthInfo | undefined;
  dependencies: { config: Config; database: Database; coordinator: Coordinator; oauth: OAuthService };
};

function registerTool(server: McpServer, tool: DiscoveredTool, { userId, authInfo, dependencies }: ToolRegistration): void {
  server.registerTool(tool.name, {
    title: tool.title,
    description: tool.description,
    inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
    ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema as JsonSchemaType) } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }, async (input, context) => {
    const requestId = context.mcpReq._meta?.requestId;
    return executeUserTool({
      userId,
      clientId: authInfo?.clientId ?? 'unknown',
      tool,
      input: input as Record<string, unknown>,
      signal: context.mcpReq.signal,
      ...(typeof requestId === 'string' ? { requestId } : {}),
      dependencies,
    });
  });
}
