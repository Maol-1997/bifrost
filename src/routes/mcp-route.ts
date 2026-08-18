import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Config } from '../config.js';
import { authenticateAgent } from '../http/auth.js';
import type { RequestContext } from '../http/context.js';
import { headerValue, json, readJsonBody } from '../http/respond.js';
import { logger } from '../logger.js';
import { toAuthInfo, type HumanIdentity } from '../mcp.js';
import { bearerChallenge } from '../oauth-server/metadata.js';

/** `POST /mcp`, the one endpoint an agent talks to. Returns false for any other path. */
export async function handleMcpRoute(context: RequestContext): Promise<boolean> {
  const { request, response, url, deps } = context;
  if (url.pathname === '/mcp/internal') {
    json(response, 501, { error: 'Service-to-service MCP endpoint is reserved but not implemented; use /mcp for human-attributed access' });
    return true;
  }
  if (url.pathname !== '/mcp') return false;
  const agent = await authenticateAgent(request, deps.database, deps.config);
  // A caller that presented something gets told the credential is the problem,
  // which is the signal that sends it to its refresh token instead of back
  // through discovery and another round of consent.
  if (!agent) {
    if (headerValue(request, 'authorization') === undefined) mcpMissingCredential(response, deps.config);
    else mcpInvalidCredential(response, deps.config);
    return true;
  }
  await handleMcp(context, agent);
  return true;
}

async function handleMcp({ request, response, deps }: RequestContext, identity: HumanIdentity): Promise<void> {
  if (request.method !== 'POST') return json(response, 405, { error: 'MCP requires POST' });
  const startedAt = performance.now();
  const requestId = headerValue(request, 'x-request-id') ?? randomUUID();
  response.setHeader('X-Request-Id', requestId);
  let parsedBody: unknown;
  try {
    parsedBody = await readJsonBody(request);
  } catch {
    return json(response, 400, { error: 'Invalid JSON request body' });
  }
  parsedBody = attachRequestId(parsedBody, requestId);
  await deps.nodeMcpHandler(withMcpAuth(request, toAuthInfo(identity)), response, parsedBody);
  const details = inspectMcpRequest(parsedBody);
  const latencyMs = Math.round(performance.now() - startedAt);
  const fields = {
    userId: identity.userId, clientId: identity.clientId, jsonRpcMethod: details.method,
    ...(details.toolName ? { toolName: details.toolName } : {}), latencyMs, statusCode: response.statusCode, requestId,
  };
  if (latencyMs >= deps.config.SLOW_REQUEST_MS) logger.warn(fields, 'Slow MCP request');
  else logger.info(fields, 'MCP request');
}

/**
 * The SDK reads the caller's identity off `request.auth`. Handing it a view of
 * the request with that field set, rather than assigning onto the incoming
 * message, keeps the identity from leaking into anything else that later sees
 * the same request object.
 */
function withMcpAuth(request: IncomingMessage, auth: AuthInfo): NodeIncomingMessageLike {
  return {
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.url === undefined ? {} : { url: request.url }),
    headers: request.headers,
    auth,
    [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
  };
}

/**
 * The challenge that starts the whole flow. Without the header a client has no
 * way to find the authorization server and simply reports that it failed.
 */
function mcpMissingCredential(response: ServerResponse, config: Config): void {
  response.setHeader('WWW-Authenticate', bearerChallenge(config.PUBLIC_URL));
  json(response, 401, { error: 'Authorization required. This server speaks OAuth 2.1; your MCP client can set it up for you' });
}

function mcpInvalidCredential(response: ServerResponse, config: Config): void {
  response.setHeader('WWW-Authenticate', bearerChallenge(config.PUBLIC_URL, 'invalid_token'));
  json(response, 401, { error: 'That credential is expired or not valid for this server' });
}

function inspectMcpRequest(body: unknown): { method: string; toolName?: string } {
  const parsed = z.object({ method: z.string(), params: z.object({ name: z.string().optional() }).loose().optional() }).safeParse(body);
  if (!parsed.success) return { method: 'invalid' };
  return { method: parsed.data.method, ...(parsed.data.params?.name ? { toolName: parsed.data.params.name } : {}) };
}

/**
 * Stamps the request id into `params._meta` so the tool handler logs the same
 * id as the request log. `_meta` is created when absent, which is the ordinary
 * case; only a `_meta` that is present but not an object is left alone, since
 * overwriting it would hide a malformed request rather than let it fail.
 */
function attachRequestId(body: unknown, requestId: string): unknown {
  if (!isPlainObject(body)) return body;
  const params = body.params;
  if (!isPlainObject(params)) return body;
  const metadata = params._meta ?? {};
  if (!isPlainObject(metadata)) return body;
  return { ...body, params: { ...params, _meta: { ...metadata, requestId } } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
