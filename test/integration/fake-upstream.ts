import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve, type ServerType } from '@hono/node-server';
import { createMcpHandler, fromJsonSchema, McpServer, type CallToolResult, type JsonSchemaType } from '@modelcontextprotocol/server';

export type FakeUpstreamTool = {
  name: string;
  description: string;
  readOnly: boolean;
};

export type RecordedUpstreamRequest = {
  method: string;
  authorization: string | undefined;
  toolName?: string;
  arguments?: unknown;
};

const ECHO_INPUT_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
} as const;

export const DEFAULT_FAKE_TOOLS: readonly FakeUpstreamTool[] = [
  { name: 'echo', description: 'Returns the message it was given.', readOnly: true },
  { name: 'create_note', description: 'Pretends to create a note.', readOnly: false },
  { name: 'hidden_probe', description: 'Never approved; must stay invisible.', readOnly: true },
];

/**
 * A provider's official MCP server, played by the real SDK over real HTTP on
 * loopback. It records every JSON-RPC request with the bearer it arrived with,
 * so a test can prove which user credential Bifrost spent and how often it
 * listed or called upstream.
 */
export class FakeUpstream {
  readonly requests: RecordedUpstreamRequest[] = [];
  /** Added before each response, so a benchmark can model a real provider's round trip. */
  latencyMs = 0;
  private tools: readonly FakeUpstreamTool[] = DEFAULT_FAKE_TOOLS;
  /** Tool callbacks that actually ran, as opposed to requests that merely arrived. */
  executions = 0;
  private failNextToolCall = false;
  private readonly expiredSessions = new Set<string>();
  private readonly issuedSessions = new Set<string>();
  private server: ServerType | undefined;
  private readonly handler = createMcpHandler(() => this.createServer(), { responseMode: 'json' });

  async start(): Promise<string> {
    const server = serve({ fetch: async (request) => this.handle(request), hostname: '127.0.0.1', port: 0 });
    this.server = server;
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await this.handler.close();
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  setTools(tools: readonly FakeUpstreamTool[]): void {
    this.tools = tools;
  }

  count(method: string, toolName?: string): number {
    return this.requests.filter((request) => request.method === method && (toolName === undefined || request.toolName === toolName)).length;
  }

  /** The next `tools/call` reaches the server and is recorded, then fails at the HTTP level. */
  failNextCall(): void {
    this.failNextToolCall = true;
  }

  /** Forgets every session handed out so far, as a provider does when it drops idle sessions. */
  expireSessions(): void {
    for (const session of this.issuedSessions) this.expiredSessions.add(session);
  }

  reset(): void {
    this.requests.length = 0;
    this.latencyMs = 0;
    this.executions = 0;
    this.tools = DEFAULT_FAKE_TOOLS;
    this.failNextToolCall = false;
    this.expiredSessions.clear();
  }

  private async handle(request: Request): Promise<Response> {
    const recorded = request.method === 'POST' ? this.record(request, await request.clone().json()) : undefined;
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    const session = request.headers.get('mcp-session-id');
    if (session !== null && this.expiredSessions.has(session)) return new Response('Session not found', { status: 404 });
    if (recorded?.method === 'tools/call' && this.failNextToolCall) {
      this.failNextToolCall = false;
      return new Response('upstream exploded mid-call', { status: 500 });
    }
    const response = await this.handler.fetch(request);
    return recorded?.method === 'initialize' ? this.withNewSession(response) : response;
  }

  /** The SDK handler here is stateless; real providers hand out a session on initialize. */
  private withNewSession(response: Response): Response {
    const session = randomUUID();
    this.issuedSessions.add(session);
    const headers = new Headers(response.headers);
    headers.set('mcp-session-id', session);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  private record(request: Request, body: unknown): RecordedUpstreamRequest {
    const message = body as { method?: string; params?: { name?: string; arguments?: unknown } };
    const recorded = {
      method: message.method ?? 'unknown',
      authorization: request.headers.get('authorization') ?? undefined,
      ...(message.params?.name === undefined ? {} : { toolName: message.params.name, arguments: message.params.arguments }),
    };
    this.requests.push(recorded);
    return recorded;
  }

  private createServer(): McpServer {
    const server = new McpServer({ name: 'fake-upstream', version: '1.0.0' }, { capabilities: { tools: {} } });
    for (const tool of this.tools) {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: fromJsonSchema(ECHO_INPUT_SCHEMA as unknown as JsonSchemaType),
        annotations: { readOnlyHint: tool.readOnly },
      }, async (input): Promise<CallToolResult> => {
        this.executions += 1;
        return { content: [{ type: 'text', text: `${tool.name}:${(input as { message: string }).message}` }] };
      });
    }
    return server;
  }
}
