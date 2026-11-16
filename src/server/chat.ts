import { createOpenAI, type OpenAIResponsesProviderOptions, type OpenAIToolOptions } from '@ai-sdk/openai';
import {
  createAgentUIStreamResponse,
  dynamicTool,
  jsonSchema,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  ToolLoopAgent,
  type ToolSet,
} from 'ai';
import type { AppDependencies } from './http/context.js';
import type { BrowserIdentity } from './mcp.js';
import type { ProviderId } from './providers/types.js';
import { createAdminAgentContext } from './tools/admin-agent-tools.js';
import type { DiscoveredTool } from './tools/catalog.js';
import { executeUserTool, loadVisibleUserTools } from './tools/user-toolset.js';

const MAX_AGENT_STEPS = 20;
const MAX_CHAT_TITLE_LENGTH = 64;
const TOOL_NAMESPACES = {
  granola: {
    name: 'granola',
    description: 'Granola tools for meeting notes, transcripts, attendees, decisions, and action items.',
  },
  github: { name: 'github', description: 'GitHub tools for repositories, code, issues, pull requests, and users.' },
  linear: { name: 'linear', description: 'Linear tools for projects, issues, teams, initiatives, and documents.' },
  notion: { name: 'notion', description: 'Notion tools for pages, databases, comments, users, and workspace search.' },
  sentry: {
    name: 'sentry',
    description: 'Sentry tools for errors, issues, events, releases, projects, and organizations.',
  },
  slack: { name: 'slack', description: 'Slack tools for messages, channels, canvases, files, users, and search.' },
} as const satisfies Record<ProviderId, NonNullable<OpenAIToolOptions['namespace']>>;
const AGENT_INSTRUCTIONS = 'You are an agent connected to Bifrost. Help the user with their requests.';
const CHAT_TITLE_INSTRUCTIONS = [
  'Create a concise, polished title for this chat from the first user message.',
  'Use the same language as the user. Use 3 to 6 words when possible.',
  'Prefer a descriptive label over repeating the message verbatim. For example, title the Spanish greeting "hola" as "Saludo en español".',
  'Return only the title, without quotes, punctuation at the end, or markdown.',
  'Do not answer the user request.',
].join(' ');

export async function createBifrostChatTitle(request: {
  dependencies: AppDependencies;
  firstMessage: string;
  signal: AbortSignal;
}): Promise<string> {
  const { config } = request.dependencies;
  if (!config.OPENAI_API_KEY) {
    throw new Error('Chat is not configured');
  }

  const openai = createChatProvider(config.OPENAI_API_KEY, config.OPENAI_BASE_URL);
  const result = streamText({
    model: openai.responses(config.OPENAI_MODEL),
    instructions: CHAT_TITLE_INSTRUCTIONS,
    prompt: request.firstMessage,
    abortSignal: request.signal,
    providerOptions: {
      openai: titleProviderOptions(),
    },
  });
  return normalizeChatTitle(await result.text);
}

export async function createBifrostChatResponse(request: {
  dependencies: AppDependencies;
  identity: BrowserIdentity;
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

  const [visibleTools, adminContext] = await Promise.all([
    loadVisibleUserTools({
      userId: request.identity.userId,
      signal: request.signal,
      dependencies: request.dependencies,
    }),
    createAdminAgentContext({
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

  const openai = createChatProvider(config.OPENAI_API_KEY, config.OPENAI_BASE_URL);
  const agent = new ToolLoopAgent({
    model: openai.responses(config.OPENAI_MODEL),
    instructions: [AGENT_INSTRUCTIONS, adminContext.instructions].filter(Boolean).join('\n\n'),
    providerOptions: {
      openai: responseProviderOptions(config),
    },
    tools: {
      tool_search: openai.tools.toolSearch(),
      web_search: openai.tools.webSearch(),
      ...deferredTools,
      ...adminContext.tools,
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

function createChatProvider(apiKey: string, baseURL: string) {
  return createOpenAI({
    apiKey,
    baseURL,
  });
}

function responseProviderOptions(config: AppDependencies['config']): OpenAIResponsesProviderOptions {
  return {
    reasoningEffort: config.OPENAI_REASONING_EFFORT,
    store: false,
  };
}

function titleProviderOptions(): OpenAIResponsesProviderOptions {
  return {
    reasoningEffort: 'none',
    store: false,
  };
}

function normalizeChatTitle(value: string): string {
  const firstLine = value.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const title = firstLine.replace(/^[#*`'"\s]+|[#*`'"\s.!?]+$/g, '');
  if (!title) throw new Error('Chat title generation returned an empty title');
  if (title.length <= MAX_CHAT_TITLE_LENGTH) return title;
  return `${title.slice(0, MAX_CHAT_TITLE_LENGTH - 1).trimEnd()}…`;
}

function createAgentTools(request: {
  dependencies: AppDependencies;
  identity: BrowserIdentity;
  tools: readonly DiscoveredTool[];
}): ToolSet {
  return Object.fromEntries(
    request.tools.map((tool) => [
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
        execute: (input, options) =>
          executeUserTool({
            userId: request.identity.userId,
            clientId: request.identity.clientId,
            tool,
            input: input as Record<string, unknown>,
            ...(options.abortSignal ? { signal: options.abortSignal } : {}),
            requestId: options.toolCallId,
            dependencies: request.dependencies,
          }),
      }),
    ]),
  );
}
