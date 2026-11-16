import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';

/** The era Bifrost serves. The SDK's exported LATEST_PROTOCOL_VERSION still names the 2025 revision it rejects. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

export type McpRequestBody = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
};

export type McpResponseBody = {
  result?: { tools?: { name: string }[]; content?: { type: string; text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
};

/** A modern request carries its protocol version and capabilities in `_meta`, not in a handshake. */
export function modernRequestBody(id: number, method: string, params: Record<string, unknown> = {}): McpRequestBody {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_META_KEY]: {} },
    },
  };
}

/** The SDK cross-checks `Mcp-Method` and, for calls, `Mcp-Name` against the body. */
export function modernRequestHeaders(body: McpRequestBody): Record<string, string> {
  const name = body.params.name;
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
    'mcp-method': body.method,
    ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
  };
}

/** The message of the error an unregistered tool gets, or undefined for any other outcome. */
export function toolNotFound(body: McpResponseBody): string | undefined {
  return body.error?.code === -32602 ? body.error.message : undefined;
}

export function firstText(body: McpResponseBody): string | undefined {
  return body.result?.content?.[0]?.text;
}
