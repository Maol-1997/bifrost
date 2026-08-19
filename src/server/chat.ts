import {
  createOpenAI,
  type OpenAIResponsesProviderOptions,
  type OpenAIToolOptions,
} from '@ai-sdk/openai';
import {
  createAgentUIStreamResponse,
  dynamicTool,
  jsonSchema,
  safeValidateUIMessages,
  stepCountIs,
  ToolLoopAgent,
  type ToolSet,
} from 'ai';
import type { AppDependencies } from './http/context.js';
import type { HumanIdentity } from './mcp.js';
import type { ProviderId } from './providers/types.js';
import { createAdminAgentTools } from './tools/admin-agent-tools.js';
import type { DiscoveredTool } from './tools/catalog.js';
import { executeUserTool, loadVisibleUserTools } from './tools/user-toolset.js';

const MAX_AGENT_STEPS = 20;
const TOOL_NAMESPACES = {
  github: { name: 'github', description: 'GitHub tools for repositories, code, issues, pull requests, and users.' },
  linear: { name: 'linear', description: 'Linear tools for projects, issues, teams, initiatives, and documents.' },
  notion: { name: 'notion', description: 'Notion tools for pages, databases, comments, users, and workspace search.' },
  sentry: { name: 'sentry', description: 'Sentry tools for errors, issues, events, releases, projects, and organizations.' },
  slack: { name: 'slack', description: 'Slack tools for messages, channels, canvases, files, users, and search.' },
} as const satisfies Record<ProviderId, NonNullable<OpenAIToolOptions['namespace']>>;
const AGENT_INSTRUCTIONS = 'You are an agent connected to Bifrost. Help the user with their requests.';

export async function createBifrostChatResponse(request: {
  dependencies: AppDependencies;
  identity: HumanIdentity;
  messages: unknown;
  signal: AbortSignal;
}): Promise<Response> {
  const { config } = request.dependencies;
  if (!config.OPENAI_API_KEY) {
    return Response.json({ error: 'Chat is not configured' }, { status: 503 });
  }

  const validatedMessages = await safeValidateUIMessages({ messages: request.messages });
  if (!validatedMessages.success) {
    return Response.json({ error: 'Invalid chat messages' }, { status: 400 });
  }

  const [visibleTools, adminTools] = await Promise.all([
    loadVisibleUserTools({
      userId: request.identity.userId,
      signal: request.signal,
      dependencies: request.dependencies,
    }),
    createAdminAgentTools({
      dependencies: request.dependencies,
      identity: request.identity,
      signal: request.signal,
    }),
  ]);
  const deferredTools = createAgentTools({
    dependencies: request.dependencies,
    identity: request.identity,
    tools: visibleTools,
  });

  const openai = createOpenAI({
    apiKey: config.OPENAI_API_KEY,
    baseURL: config.OPENAI_BASE_URL,
  });
  const agent = new ToolLoopAgent({
    model: openai.responses(config.OPENAI_MODEL),
    instructions: AGENT_INSTRUCTIONS,
    providerOptions: {
      openai: {
        reasoningEffort: config.OPENAI_REASONING_EFFORT,
        store: false,
      } satisfies OpenAIResponsesProviderOptions,
    },
    tools: {
      tool_search: openai.tools.toolSearch(),
      ...deferredTools,
      ...adminTools,
    },
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
  });
  return createAgentUIStreamResponse({
    agent,
    uiMessages: validatedMessages.data,
    abortSignal: request.signal,
    onError: () => 'Bifrost could not complete that request.',
  });
}

function createAgentTools(request: {
  dependencies: AppDependencies;
  identity: HumanIdentity;
  tools: readonly DiscoveredTool[];
}): ToolSet {
  return Object.fromEntries(request.tools.map((tool) => [
    tool.name,
    dynamicTool({
      title: tool.title,
      description: tool.description,
      inputSchema: jsonSchema(tool.inputSchema as Parameters<typeof jsonSchema>[0]),
      providerOptions: {
        openai: {
          deferLoading: true,
          namespace: TOOL_NAMESPACES[tool.providerId],
        } satisfies OpenAIToolOptions,
      },
      metadata: { providerId: tool.providerId, source: 'bifrost' },
      execute: (input, options) => executeUserTool({
        userId: request.identity.userId,
        clientId: request.identity.clientId,
        tool,
        input: input as Record<string, unknown>,
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
        requestId: options.toolCallId,
        dependencies: request.dependencies,
      }),
    }),
  ]));
}
