import type { UIMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wasDeclined } from '../src/app/chat/utils/chat-messages.js';
import { loadConfig } from '../src/server/config.js';
import type { AppDependencies } from '../src/server/http/context.js';
import type { BrowserIdentity } from '../src/server/mcp.js';
import type { DiscoveredTool } from '../src/server/tools/catalog.js';

const visibleTools = vi.hoisted(() => ({ current: [] as DiscoveredTool[] }));
vi.mock('../src/server/tools/user-toolset.js', () => ({
  loadVisibleUserTools: async () => visibleTools.current,
  executeUserTool: async () => ({ content: [] }),
}));

const { createBifrostChatResponse } = await import('../src/server/chat.js');

const ADMIN_EMAIL = 'admin@example.test';
const GITHUB_TOOL = {
  providerId: 'github',
  upstreamName: 'get_issue',
  name: 'github_get_issue',
  title: 'Get issue',
  description: 'Read one GitHub issue.',
  mutability: 'read',
  fingerprint: 'fingerprint',
  inputSchema: { type: 'object', properties: { number: { type: 'number' } } },
} as unknown as DiscoveredTool;

type CapturedRequest = { body: Record<string, unknown>; headers: Headers };

function anthropicStream(text: string, stopReason: string): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function stubAnthropic(stopReason = 'end_turn'): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    requests.push({
      body: JSON.parse(init.body as string) as Record<string, unknown>,
      headers: new Headers(init.headers),
    });
    return anthropicStream(stopReason === 'refusal' ? '' : 'Hello.', stopReason);
  });
  return requests;
}

function dependencies(options: { apiKey?: string; email?: string } = {}): AppDependencies {
  const config = loadConfig({
    NODE_ENV: 'test',
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    ADMIN_EMAILS: ADMIN_EMAIL,
    ...(options.apiKey === undefined ? { ANTHROPIC_API_KEY: 'test-key' } : { ANTHROPIC_API_KEY: options.apiKey }),
  });
  return {
    config,
    database: {
      getUser: async () => ({ email: options.email ?? 'user@example.test' }),
      providerAgentNotes: async () => new Map(),
    },
  } as unknown as AppDependencies;
}

const identity = { kind: 'browser', userId: 'user-1', sessionId: 'session-1', clientId: 'web' } as BrowserIdentity;
const question: UIMessage = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'What changed today?' }] };

async function chat(messages: UIMessage[], deps = dependencies()): Promise<Response> {
  return createBifrostChatResponse({ dependencies: deps, identity, messages, signal: new AbortController().signal });
}

type ToolDefinition = { name: string; type?: string; defer_loading?: boolean };

describe('web chat on Claude', () => {
  beforeEach(() => {
    visibleTools.current = [GITHUB_TOOL];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports that the chat is not configured without an Anthropic key', async () => {
    const response = await chat([question], dependencies({ apiKey: '' }));

    expect(response.status).toBe(503);
  });

  it('asks Sonnet 5.5 for adaptive thinking at high effort with server-side fallback', async () => {
    const requests = stubAnthropic();

    await (await chat([question])).text();

    const [request] = requests;
    expect(request?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      stream: true,
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      output_config: { effort: 'high' },
      fallbacks: 'default',
    });
    for (const field of ['temperature', 'top_p', 'top_k']) expect(request?.body).not.toHaveProperty(field);
    expect(request?.body).toMatchObject({ tool_choice: { type: 'auto' } });
    expect(request?.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(request?.headers.get('anthropic-beta')).toContain('thinking-binding-controls-2026-08-01');
  });

  it('defers Bifrost tools behind BM25 tool search and keeps the server tools loaded', async () => {
    const requests = stubAnthropic();

    await (await chat([question])).text();

    const tools = requests[0]?.body.tools as ToolDefinition[];
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('tool_search_tool_bm25')).toMatchObject({ type: 'tool_search_tool_bm25_20251119' });
    expect(byName.get('web_search')).toMatchObject({ type: 'web_search_20260209' });
    expect(byName.get('github_get_issue')).toMatchObject({ defer_loading: true });
    expect(byName.get('tool_search_tool_bm25')?.defer_loading).not.toBe(true);
    expect(byName.get('web_search')?.defer_loading).not.toBe(true);
  });

  it('defers the admin tools for an administrator', async () => {
    visibleTools.current = [];
    const requests = stubAnthropic();

    await (await chat([question], dependencies({ email: ADMIN_EMAIL }))).text();

    const tools = requests[0]?.body.tools as ToolDefinition[];
    const adminTools = tools.filter((tool) => tool.name.startsWith('bifrost_admin_'));
    expect(adminTools.length).toBeGreaterThan(0);
    expect(adminTools.every((tool) => tool.defer_loading === true)).toBe(true);
    expect(tools.map((tool) => tool.name)).toContain('tool_search_tool_bm25');
  });

  it('leaves tool search out when nothing is deferred', async () => {
    visibleTools.current = [];
    const requests = stubAnthropic();

    await (await chat([question])).text();

    const tools = requests[0]?.body.tools as ToolDefinition[];
    expect(tools.map((tool) => tool.name)).toEqual(['web_search']);
  });

  it('sends earlier thinking blocks back unchanged', async () => {
    const requests = stubAnthropic();
    const answer: UIMessage = {
      id: 'm2',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'reasoning', text: '', providerMetadata: { anthropic: { signature: 'signed-thinking' } } },
        { type: 'text', text: 'Two issues were closed.' },
      ],
    };
    const followUp: UIMessage = { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'Which ones?' }] };

    await (await chat([question, answer, followUp])).text();

    const messages = requests[0]?.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'signed-thinking' },
        { type: 'text', text: 'Two issues were closed.' },
      ],
    });
  });

  it('marks a declined answer so the chat can explain it', async () => {
    stubAnthropic('refusal');

    const body = await (await chat([question])).text();

    const finish = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; messageMetadata?: unknown })
      .find((chunk) => chunk.type === 'finish');
    expect(finish?.messageMetadata).toEqual({ finishReason: 'content-filter' });
  });
});

describe('declined answers', () => {
  const assistant = (metadata: unknown): UIMessage => ({ id: 'a', role: 'assistant', metadata, parts: [] });

  it('recognizes a refusal recorded by the server', () => {
    expect(wasDeclined(assistant({ finishReason: 'content-filter' }))).toBe(true);
  });

  it('ignores normal endings and messages without metadata', () => {
    expect(wasDeclined(assistant({ finishReason: 'stop' }))).toBe(false);
    expect(wasDeclined(assistant(undefined))).toBe(false);
    expect(wasDeclined({ id: 'u', role: 'user', metadata: { finishReason: 'content-filter' }, parts: [] })).toBe(false);
  });
});
