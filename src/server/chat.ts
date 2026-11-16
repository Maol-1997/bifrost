import {
  createAnthropic,
  type AnthropicLanguageModelOptions,
  type AnthropicProvider,
  type AnthropicToolOptions,
} from '@ai-sdk/anthropic';
import {
  createAgentUIStreamResponse,
  dynamicTool,
  jsonSchema,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  ToolLoopAgent,
  type FinishReason,
  type TextStreamPart,
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
// Every provider and admin tool is deferred: the model finds the ones it needs with
// tool search instead of reading every definition on every turn.
const DEFERRED_TOOL_OPTIONS = { deferLoading: true } as const satisfies AnthropicToolOptions;
const PROVIDER_TOOL_TOPICS = {
  granola: 'meeting notes, transcripts, attendees, decisions, and action items',
  github: 'repositories, code, issues, pull requests, and users',
  linear: 'projects, issues, teams, initiatives, and documents',
  notion: 'pages, databases, comments, users, and workspace search',
  sentry: 'errors, issues, events, releases, projects, and organizations',
  slack: 'messages, channels, canvases, files, users, and search',
} as const satisfies Record<ProviderId, string>;
const AGENT_INSTRUCTIONS = 'You are an agent connected to Bifrost. Help the user with their requests.';
const TOOL_SEARCH_INSTRUCTIONS =
  "The user's connected tools are not listed up front. Use tool search to find the ones a request needs. Tool names start with the provider, such as github_ or linear_.";
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
  const anthropic = createChatProvider(config);
  if (!anthropic) {
    throw new Error('Chat is not configured');
  }

  const result = streamText({
    model: anthropic(config.ANTHROPIC_MODEL),
    instructions: CHAT_TITLE_INSTRUCTIONS,
    prompt: request.firstMessage,
    abortSignal: request.signal,
    providerOptions: {
      anthropic: { effort: 'low', fallbacks: 'default' } satisfies AnthropicLanguageModelOptions,
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
  const anthropic = createChatProvider(config);
  if (!anthropic) {
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

  const hasDeferredTools = Object.keys(deferredTools).length + Object.keys(adminContext.tools).length > 0;
  const agent = new ToolLoopAgent({
    model: anthropic(config.ANTHROPIC_MODEL),
    instructions: [
      AGENT_INSTRUCTIONS,
      hasDeferredTools ? toolSearchInstructions(visibleTools) : undefined,
      adminContext.instructions,
    ]
      .filter(Boolean)
      .join('\n\n'),
    providerOptions: {
      anthropic: chatProviderOptions(config),
    },
    tools: {
      ...createServerTools(anthropic, { toolSearch: hasDeferredTools }),
      ...deferredTools,
      ...adminContext.tools,
    },
    toolApproval: adminContext.toolApproval,
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
  });
  return createAgentUIStreamResponse({
    agent,
    uiMessages: validatedMessages.data,
    abortSignal: request.signal,
    messageMetadata: chatMessageMetadata,
    onError: () => 'Bifrost could not complete that request.',
  });
}

/** The Anthropic provider for the chat, or undefined when no key is configured. */
export function createChatProvider(config: AppDependencies['config']): AnthropicProvider | undefined {
  if (!config.ANTHROPIC_API_KEY) return undefined;
  return createAnthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    ...(config.ANTHROPIC_BASE_URL ? { baseURL: config.ANTHROPIC_BASE_URL } : {}),
  });
}

export function chatProviderOptions(config: AppDependencies['config']) {
  return {
    // Sonnet 5.5 always thinks adaptively; effort is the only depth control.
    // The chat history lives in the browser and the system prompt and tool list
    // can change between turns (admin notes, tool toggles), which invalidates
    // earlier thinking blocks. drop_block lets such a turn continue without that
    // reasoning instead of failing with a 400.
    thinking: { type: 'adaptive', blockBinding: { prefixMismatchBehavior: 'drop_block' } },
    effort: config.ANTHROPIC_EFFORT,
    // When a safety classifier declines a turn, the API retries it on a
    // fallback model chosen for that refusal category before giving up.
    fallbacks: 'default',
    cacheControl: { type: 'ephemeral' },
  } as const satisfies AnthropicLanguageModelOptions;
}

/**
 * Anthropic's server tools. They run on Anthropic's side and are never deferred,
 * so the request always keeps at least one tool loaded next to tool search.
 */
export function createServerTools(anthropic: AnthropicProvider, options: { toolSearch: boolean }): ToolSet {
  return {
    ...(options.toolSearch ? { tool_search: anthropic.tools.toolSearchBm25_20251119() } : {}),
    web_search: anthropic.tools.webSearch_20260209(),
  };
}

/** Keeps the finish reason on the message so the browser can explain a refusal, also after a reload. */
export function chatMessageMetadata({ part }: { part: TextStreamPart<ToolSet> }): ChatMessageMetadata | undefined {
  return part.type === 'finish' ? { finishReason: part.finishReason } : undefined;
}

type ChatMessageMetadata = { finishReason: FinishReason };

function toolSearchInstructions(tools: readonly DiscoveredTool[]): string {
  const providers = [...new Set(tools.map((tool) => tool.providerId))].sort();
  const topics = providers.map((providerId) => `- ${providerId}_: ${PROVIDER_TOOL_TOPICS[providerId]}`);
  return [TOOL_SEARCH_INSTRUCTIONS, ...topics].join('\n');
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
        providerOptions: { anthropic: DEFERRED_TOOL_OPTIONS },
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
