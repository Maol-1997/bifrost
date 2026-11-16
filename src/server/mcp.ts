import {
  createMcpHandler,
  fromJsonSchema,
  LATEST_PROTOCOL_VERSION,
  McpServer,
  type AuthInfo,
  type JsonSchemaType,
  type McpHttpHandler,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import { errorSummary, logger } from './logger.js';
import type { DiscoveredTool } from './tools/catalog.js';
import {
  executeUserTool,
  loadVisibleUserTool,
  loadVisibleUserTools,
  type ToolExecutionDependencies,
  type UserToolDependencies,
} from './tools/user-toolset.js';

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

export function createHumanMcpHandler(dependencies: UserToolDependencies): McpHttpHandler {
  return createMcpHandler(
    async (requestContext) => {
      const userId = requestContext.authInfo?.extra?.userId;
      if (typeof userId !== 'string') throw new Error('Authenticated user identity is missing');
      const signalOption = requestContext.requestInfo ? { signal: requestContext.requestInfo.signal } : {};
      const calledToolName = toolCallName(requestContext);
      const tools =
        calledToolName === undefined
          ? await loadVisibleUserTools({ userId, dependencies, ...signalOption })
          : await loadVisibleUserTool({ userId, toolName: calledToolName, dependencies, ...signalOption }).then(
              (tool) => (tool ? [tool] : []),
            );
      const server = new McpServer(
        { name: 'bifrost', version: '0.1.0' },
        {
          capabilities: { tools: {} },
          instructions: `Bifrost unified internal gateway. Protocol ${LATEST_PROTOCOL_VERSION}.`,
        },
      );
      for (const tool of tools) {
        try {
          registerTool(server, tool, { userId, authInfo: requestContext.authInfo, dependencies });
        } catch (error) {
          // A schema the SDK cannot convert is that one tool's problem. Leaving it
          // out is fail-closed; letting it throw would fail the whole request,
          // hiding every other provider behind one broken definition.
          logger.warn(
            { userId, toolName: tool.name, ...errorSummary(error) },
            'Skipped an MCP tool that could not be registered',
          );
        }
      }
      return server;
    },
    {
      legacy: 'reject',
      responseMode: 'json',
      onerror: (error) => logger.error(errorSummary(error), 'MCP handler error'),
    },
  );
}

/**
 * The tool a modern `tools/call` names in its `Mcp-Name` header, which the SDK
 * cross-checks against the body. The SDK only dispatches a call to a tool
 * registered on the server, so such a request gets a server holding that one
 * tool when it is visible, or none, which answers with the same
 * "Tool … not found" error the full registration gives an invisible tool.
 * A header naming one tool and a body naming another can only reach an
 * unregistered tool. Everything else, `tools/list` included, gets the full set.
 */
function toolCallName(requestContext: McpRequestContext): string | undefined {
  const headers = requestContext.requestInfo?.headers;
  if (requestContext.era !== 'modern' || headers?.get('mcp-method') !== 'tools/call') return undefined;
  return headers.get('mcp-name') ?? undefined;
}

type ToolRegistration = {
  userId: string;
  authInfo: AuthInfo | undefined;
  dependencies: ToolExecutionDependencies;
};

function registerTool(
  server: McpServer,
  tool: DiscoveredTool,
  { userId, authInfo, dependencies }: ToolRegistration,
): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
      ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema as JsonSchemaType) } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    },
    async (input, context) => {
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
    },
  );
}
